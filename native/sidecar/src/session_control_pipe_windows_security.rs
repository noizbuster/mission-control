#![cfg(windows)]

use std::path::Path;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::core::PWSTR;

pub(super) struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub(super) fn new(handle: HANDLE) -> anyhow::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(handle))
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                // SAFETY: this wrapper uniquely owns the validated HANDLE.
                let _ = CloseHandle(self.0);
            }
            self.0 = null_mut();
        }
    }
}

struct LocalAllocation(HLOCAL);

impl LocalAllocation {
    fn new(pointer: HLOCAL) -> anyhow::Result<Self> {
        if pointer.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(pointer))
    }
}

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                // SAFETY: this wrapper uniquely owns a LocalAlloc allocation.
                let _ = LocalFree(self.0);
            }
            self.0 = null_mut();
        }
    }
}

pub(super) struct CurrentUserSecurity {
    _descriptor: LocalAllocation,
    dacl: *mut ACL,
    attributes: SECURITY_ATTRIBUTES,
}

impl CurrentUserSecurity {
    pub(super) fn new() -> anyhow::Result<Self> {
        let sid = current_user_sid_string()?;
        let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})"));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let converted = unsafe {
            // SAFETY: SDDL is NUL-terminated and outputs point to valid storage.
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let descriptor = LocalAllocation::new(descriptor)?;
        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut dacl: *mut ACL = null_mut();
        let got_dacl = unsafe {
            // SAFETY: descriptor remains alive and outputs are writable.
            GetSecurityDescriptorDacl(
                descriptor.0,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
        };
        if got_dacl == 0 || dacl_present == 0 || dacl.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        Ok(Self {
            _descriptor: descriptor,
            dacl,
            attributes,
        })
    }

    pub(super) fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
        &self.attributes
    }

    pub(super) fn create_or_secure_directory(&self, path: &Path) -> anyhow::Result<()> {
        let mut path_wide = wide_path(path);
        let created = unsafe {
            // SAFETY: path and security attributes are valid and NUL-terminated.
            CreateDirectoryW(path_wide.as_ptr(), self.attributes())
        };
        if created == 0
            && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32)
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let result = unsafe {
            // SAFETY: path is mutable and DACL is backed by the live descriptor.
            SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                self.dacl,
                null_mut(),
            )
        };
        if result != 0 {
            anyhow::bail!("failed to secure session control registry directory: {result}")
        }
        Ok(())
    }
}

fn current_user_sid_string() -> anyhow::Result<String> {
    let mut token = null_mut();
    let opened = unsafe {
        // SAFETY: token points to writable HANDLE storage.
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
    };
    if opened == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let _token = OwnedHandle::new(token)?;
    let mut required = 0;
    unsafe {
        // SAFETY: null buffer requests the required TOKEN_USER byte length.
        let _ = windows_sys::Win32::Security::GetTokenInformation(
            token,
            TokenUser,
            null_mut(),
            0,
            &mut required,
        );
    }
    if required < std::mem::size_of::<TOKEN_USER>() as u32 {
        anyhow::bail!("current-user token did not return a SID")
    }
    let mut token_user = vec![0_u8; required as usize];
    let loaded = unsafe {
        // SAFETY: token_user has the exact capacity requested by Win32.
        windows_sys::Win32::Security::GetTokenInformation(
            token,
            TokenUser,
            token_user.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if loaded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let user = unsafe {
        // SAFETY: read_unaligned copies TOKEN_USER from byte-aligned storage.
        std::ptr::read_unaligned(token_user.as_ptr().cast::<TOKEN_USER>())
    };
    let mut sid_text: PWSTR = null_mut();
    let converted = unsafe {
        // SAFETY: SID remains in token_user and sid_text is writable output.
        ConvertSidToStringSidW(user.User.Sid, &mut sid_text)
    };
    if converted == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let sid_allocation = LocalAllocation::new(sid_text.cast())?;
    let mut length = 0;
    while unsafe { *sid_text.add(length) } != 0 {
        length += 1;
    }
    let sid = String::from_utf16(unsafe {
        // SAFETY: length ends at the NUL in the live LocalAlloc string.
        std::slice::from_raw_parts(sid_text, length)
    })?;
    drop(sid_allocation);
    Ok(sid)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
