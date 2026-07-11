//! Stateful brush-shell sessions for sidecar protocol v3 `shell.session`.
//!
//! One `ShellSessionStore` holds `brush_core::Shell` instances keyed by
//! `sessionId`. Sessions persist across `stream_open` calls so environment
//! exports (`export X=1`) and working-directory changes survive between calls.
//! Output is captured through an `os_pipe` and emitted as `SidecarStreamFrame`s
//! (task 2's envelope). Containment (30s timeout, 64KB cap, cwd gate, secret
//! redaction) is owned by the TypeScript caller; this handler is the trusted
//! execution boundary that receives a already-vetted env + cwd.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::shell_cancellation::ShellCancellationRegistry;
use anyhow::{Result, anyhow};
use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
    ExecutionParameters, ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue,
    ShellVariable, SourceInfo,
    openfiles::{OpenFile, OpenFiles},
};
use tokio::sync::Mutex;

/// Raw capture backstop. The TS tool applies the authoritative 64KB cap with a
/// continuation hint; this bound only guards the sidecar's own buffer so a
/// runaway command cannot grow memory unbounded before the frame is emitted.
const RAW_CAPTURE_CAP_BYTES: usize = 256 * 1024;

/// Default per-command timeout when the caller does not supply one. Mirrors
/// `defaultBashRunTimeoutMs` (30s) so the sidecar kills a hung brush run even if
/// the TS-side timeout has not fired yet.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ShellSessionStore {
    sessions: Mutex<HashMap<String, Arc<Mutex<BrushShell>>>>,
    cancellations: ShellCancellationRegistry,
}

impl ShellSessionStore {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cancellations: ShellCancellationRegistry::new(),
        }
    }

    /// Run `command` in the persistent session for `session_id`, creating the
    /// session with `env` on first use. Returns the captured combined
    /// stdout/stderr, the exit code (if the command completed), and whether the
    /// timeout fired.
    pub async fn run(
        &self,
        session_id: &str,
        command: &str,
        cwd: Option<&str>,
        env: Option<&HashMap<String, String>>,
        timeout: Duration,
    ) -> Result<ShellRunOutcome> {
        let cancellation = self.cancellations.register(session_id).await?;
        let result = async {
            let shell = self.get_or_create(session_id, env).await?;
            if let Some(cwd) = cwd {
                self.apply_cwd(&shell, cwd).await?;
            }
            tokio::select! {
                result = run_captured(&shell, command, timeout) => result,
                () = cancellation.notified() => Ok(ShellRunOutcome {
                    exit_code: None,
                    output: String::new(),
                    timed_out: false,
                    interrupted: true,
                }),
            }
        }
        .await;
        self.cancellations.finish(session_id).await;
        result
    }

    pub async fn cancel(&self, session_id: &str) -> bool {
        self.cancellations.cancel(session_id).await
    }

    async fn get_or_create(
        &self,
        session_id: &str,
        env: Option<&HashMap<String, String>>,
    ) -> Result<Arc<Mutex<BrushShell>>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(shell) = sessions.get(session_id) {
            return Ok(Arc::clone(shell));
        }
        let shell = Arc::new(Mutex::new(create_brush_shell(env).await?));
        sessions.insert(session_id.to_string(), Arc::clone(&shell));
        Ok(shell)
    }

    async fn apply_cwd(&self, shell: &Arc<Mutex<BrushShell>>, cwd: &str) -> Result<()> {
        let path = Path::new(cwd);
        if !path.is_dir() {
            return Err(anyhow!("cwd is not an existing directory: {cwd}"));
        }
        let mut shell = shell.lock().await;
        let mut var = ShellVariable::new(ShellValue::String(cwd.to_string()));
        var.export();
        shell
            .env_mut()
            .set_global("PWD", var)
            .map_err(|e| anyhow!("failed to set PWD: {e}"))?;
        let mut params = shell.default_exec_params();
        let null_in = openfiles_null()?;
        let null_out = openfiles_null()?;
        let null_err = openfiles_null()?;
        params.set_fd(OpenFiles::STDIN_FD, null_in);
        params.set_fd(OpenFiles::STDOUT_FD, null_out);
        params.set_fd(OpenFiles::STDERR_FD, null_err);
        let source = SourceInfo::from("sidecar:shell:cwd");
        let escaped = cwd.replace('\'', "'\\''");
        let cd = format!("cd '{escaped}'");
        shell
            .run_string(cd, &source, &params)
            .await
            .map_err(|e| anyhow!("cwd change failed: {e}"))?;
        Ok(())
    }
}

impl Default for ShellSessionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct ShellRunOutcome {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub interrupted: bool,
}

async fn create_brush_shell(env: Option<&HashMap<String, String>>) -> Result<BrushShell> {
    let mut shell = BrushShell::builder()
        .do_not_inherit_env(true)
        .profile(ProfileLoadBehavior::Skip)
        .rc(RcLoadBehavior::Skip)
        .builtins(default_builtins(BuiltinSet::BashMode))
        .build()
        .await
        .map_err(|e| anyhow!("failed to initialize brush shell: {e}"))?;

    // External commands need a PATH. Prefer the caller-supplied (already
    // allowlisted) PATH; fall back to the sidecar process PATH so commands still
    // resolve when no env was forwarded.
    let path_value = env
        .and_then(|map| map.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok());
    if let Some(path_value) = path_value
        && !path_value.is_empty()
    {
        set_export(&mut shell, "PATH", &path_value)?;
    }

    if let Some(env) = env {
        for (key, value) in env {
            if key == "PATH" {
                continue;
            }
            set_export(&mut shell, key, value)?;
        }
    }
    Ok(shell)
}

fn set_export(shell: &mut BrushShell, key: &str, value: &str) -> Result<()> {
    let mut var = ShellVariable::new(ShellValue::String(value.to_string()));
    var.export();
    shell
        .env_mut()
        .set_global(key, var)
        .map_err(|e| anyhow!("failed to set env {key}: {e}"))?;
    Ok(())
}

fn openfiles_null() -> Result<OpenFile> {
    Ok(OpenFile::File(open_dev_null()?))
}

fn open_dev_null() -> Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .open("/dev/null")
        .map_err(|e| anyhow!("failed to open /dev/null: {e}"))
}

async fn run_captured(
    shell: &Arc<Mutex<BrushShell>>,
    command: &str,
    timeout: Duration,
) -> Result<ShellRunOutcome> {
    let (reader, writer) = os_pipe::pipe().map_err(|e| anyhow!("pipe creation failed: {e}"))?;
    let writer_err = writer
        .try_clone()
        .map_err(|e| anyhow!("pipe clone failed: {e}"))?;

    let mut shell = shell.lock().await;
    let mut params: ExecutionParameters = shell.default_exec_params();
    let null_in = openfiles_null()?;
    params.set_fd(OpenFiles::STDIN_FD, null_in);
    params.set_fd(
        OpenFiles::STDOUT_FD,
        OpenFile::File(pipe_writer_to_file(writer)?),
    );
    params.set_fd(
        OpenFiles::STDERR_FD,
        OpenFile::File(pipe_writer_to_file(writer_err)?),
    );

    let drain = tokio::task::spawn_blocking(move || drain_pipe(reader));

    let source = SourceInfo::from("sidecar:shell");
    let run = shell.run_string(command.to_string(), &source, &params);
    let result = tokio::time::timeout(timeout, run).await;
    // Drop params so the writer fds close and the drain hits EOF.
    drop(params);

    let bytes = drain
        .await
        .map_err(|e| anyhow!("output drain join failed: {e}"))??;
    let output = String::from_utf8_lossy(&bytes).into_owned();

    match result {
        Ok(Ok(exec_result)) => Ok(ShellRunOutcome {
            exit_code: Some(u8::from(exec_result.exit_code) as i32),
            output,
            timed_out: false,
            interrupted: false,
        }),
        Ok(Err(e)) => Err(anyhow!("shell execution failed: {e}")),
        Err(_) => Ok(ShellRunOutcome {
            exit_code: None,
            output,
            timed_out: true,
            interrupted: false,
        }),
    }
}

fn drain_pipe(reader: os_pipe::PipeReader) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let mut reader = reader;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let remaining = RAW_CAPTURE_CAP_BYTES.saturating_sub(buf.len());
                let take = n.min(remaining);
                if take > 0 {
                    buf.extend_from_slice(&chunk[..take]);
                }
                if buf.len() >= RAW_CAPTURE_CAP_BYTES {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    Ok(buf)
}

#[cfg(unix)]
fn pipe_writer_to_file(pipe: os_pipe::PipeWriter) -> Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::io::IntoRawFd;
    // SAFETY: `into_raw_fd` transfers ownership of a live kernel file
    // descriptor out of the `PipeWriter`; `from_raw_fd` reclaims that same
    // ownership into a `std::fs::File`. The fd is neither leaked nor double
    // closed because exactly one owner exists on each side of the transfer.
    let fd = pipe.into_raw_fd();
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn pipe_writer_to_file(pipe: os_pipe::PipeWriter) -> Result<std::fs::File> {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};
    // SAFETY: `into_raw_handle` transfers the pipe HANDLE to the File, leaving
    // exactly one owner responsible for closing it.
    let handle = pipe.into_raw_handle();
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
