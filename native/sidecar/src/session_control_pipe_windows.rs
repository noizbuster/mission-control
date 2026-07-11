#![cfg(windows)]

use std::ffi::c_void;
use std::fs::File;
use std::io::Write;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::null_mut;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::NamedPipeServer;
use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED, FlushFileBuffers, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    MoveFileExW, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

use crate::session_control_pipe::{SessionControlProxyBootstrap, pipe_name, registry_json};

#[path = "session_control_pipe_windows_security.rs"]
mod security;
use security::CurrentUserSecurity;

const MAX_PROXY_COMMAND_BYTES: u64 = 262_144;

pub(super) async fn run_proxy(
    bootstrap: SessionControlProxyBootstrap,
    mut stdin: BufReader<tokio::io::Stdin>,
) -> anyhow::Result<()> {
    let security = CurrentUserSecurity::new()?;
    let endpoint = pipe_name(&bootstrap);
    let endpoint_wide = wide(&endpoint);
    let handle = unsafe {
        // SAFETY: the endpoint and security descriptor outlive this call; the
        // returned HANDLE is transferred to Tokio immediately below.
        CreateNamedPipeW(
            endpoint_wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65_536,
            65_536,
            0,
            security.attributes(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut pipe = unsafe {
        // SAFETY: this is the sole owner of the validated overlapped pipe
        // HANDLE; Tokio assumes responsibility for closing it.
        NamedPipeServer::from_raw_handle(handle.cast())?
    };

    security.create_or_secure_directory(Path::new(&bootstrap.registry_dir))?;
    publish_registry(&security, &bootstrap, &endpoint)?;
    let mut stdout = tokio::io::stdout();
    stdout.write_all(b"{\"type\":\"ready\"}\n").await?;
    stdout.flush().await?;
    loop {
        let mut unexpected_command = Vec::new();
        tokio::select! {
            connected = pipe.connect() => connected?,
            input = read_proxy_command(&mut stdin, &mut unexpected_command) => {
                if input? == 0 {
                    return Ok(());
                }
                anyhow::bail!("session control proxy received data before a client connected")
            }
        }
        write_event(&mut stdout, r#"{"type":"client_connected"}"#).await?;
        if !bridge_client(&mut pipe, &mut stdin, &mut stdout).await? {
            return Ok(());
        }
        pipe.disconnect()?;
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ProxyCommand {
    HostData { data: String },
    HostClose,
}

async fn bridge_client(
    pipe: &mut NamedPipeServer,
    stdin: &mut BufReader<tokio::io::Stdin>,
    stdout: &mut tokio::io::Stdout,
) -> anyhow::Result<bool> {
    let mut pipe_bytes = [0_u8; 65_536];
    let mut command_line = Vec::new();
    loop {
        tokio::select! {
            read = pipe.read(&mut pipe_bytes) => {
                let read = read?;
                if read == 0 {
                    write_event(stdout, r#"{"type":"client_closed"}"#).await?;
                    return Ok(true);
                }
                let data = encode_hex(&pipe_bytes[..read]);
                write_event(stdout, &format!(r#"{{"type":"client_data","data":"{data}"}}"#)).await?;
            }
            read = read_proxy_command(stdin, &mut command_line) => {
                if read? == 0 {
                    return Ok(false);
                }
                let command_text = std::str::from_utf8(&command_line)?;
                let command: ProxyCommand = serde_json::from_str(command_text.trim_end())?;
                command_line.clear();
                match command {
                    ProxyCommand::HostData { data } => pipe.write_all(&decode_hex(&data)?).await?,
                    ProxyCommand::HostClose => {
                        pipe.shutdown().await?;
                        write_event(stdout, r#"{"type":"client_closed"}"#).await?;
                        return Ok(true);
                    }
                }
            }
        }
    }
}

async fn read_proxy_command(
    stdin: &mut BufReader<tokio::io::Stdin>,
    command: &mut Vec<u8>,
) -> anyhow::Result<usize> {
    let remaining = (MAX_PROXY_COMMAND_BYTES + 1).saturating_sub(command.len() as u64);
    let read = stdin.take(remaining).read_until(b'\n', command).await?;
    if command.len() as u64 > MAX_PROXY_COMMAND_BYTES
        || (read == 0 && !command.is_empty())
        || (!command.is_empty() && !command.ends_with(b"\n"))
    {
        anyhow::bail!("session control proxy command exceeds the byte limit")
    }
    Ok(command.len())
}

async fn write_event(stdout: &mut tokio::io::Stdout, event: &str) -> anyhow::Result<()> {
    stdout.write_all(event.as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> anyhow::Result<Vec<u8>> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("invalid session control proxy data")
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(Into::into))
        .collect()
}

fn publish_registry(
    security: &CurrentUserSecurity,
    bootstrap: &SessionControlProxyBootstrap,
    endpoint: &str,
) -> anyhow::Result<()> {
    let registry_path = Path::new(&bootstrap.registry_path);
    let file_name = registry_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid registry file name"))?;
    let temporary_path = Path::new(&bootstrap.registry_dir)
        .join(format!(".{file_name}.{}.tmp", bootstrap.pipe_random));
    let temporary_wide = wide_path(&temporary_path);
    let handle = unsafe {
        // SAFETY: path and security attributes are valid; ownership of the
        // returned HANDLE transfers immediately into File below.
        CreateFileW(
            temporary_wide.as_ptr(),
            GENERIC_WRITE,
            0,
            security.attributes(),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = unsafe {
        // SAFETY: handle is a newly-created file HANDLE with unique ownership.
        File::from_raw_handle(handle.cast::<c_void>())
    };
    let bytes = registry_json(bootstrap, endpoint)?;
    file.write_all(bytes.as_bytes())?;
    let flushed = unsafe {
        // SAFETY: file owns a valid open file HANDLE for this call.
        FlushFileBuffers(handle)
    };
    if flushed == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    drop(file);

    let registry_wide = wide_path(registry_path);
    let moved = unsafe {
        // SAFETY: both path buffers are NUL-terminated and remain alive.
        MoveFileExW(
            temporary_wide.as_ptr(),
            registry_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        let _ = std::fs::remove_file(temporary_path);
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
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
