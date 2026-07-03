//! PTY allocation for sidecar protocol v3 `pty.alloc`.
//!
//! Allocates a pseudo-terminal via `portable-pty`, runs a command (default
//! `sh -c <command>`), captures the combined output, and emits it as
//! `SidecarStreamFrame`s (task 2's single streaming envelope). The 64KB
//! cumulative output cap is enforced HERE so a flooding process cannot grow
//! memory unbounded or flood the model; the TypeScript `pty-client` applies the
//! same cap as belt-and-suspenders.
//!
//! Adapted from oh-my-pi `crates/pi-natives/src/pty.rs` (MIT, (c) Mario Zechner
//! and Can Boluk). Reimplemented for the sidecar JSON Lines boundary: no
//! N-API, no callbacks, no tokio inside the blocking run; frames instead of
//! ThreadsafeFunction chunks.

use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};

use crate::protocol::stream_frame_response;

/// Default per-allocation timeout when the caller does not supply one. Mirrors
/// `defaultBashRunTimeoutMs` (30s) so a hung pty dies even if the TS-side
/// timeout has not fired yet.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Cumulative output cap. The drain thread stops reading once this many bytes
/// have been captured and signals the wait loop to terminate the child. A
/// flooding process therefore cannot stream unbounded data to the model
/// (Metis P1-8). Mirrors the 64KB bash.run / shell.session cap.
pub const PTY_OUTPUT_CAP_BYTES: usize = 64 * 1024;

/// Per-frame payload target when chunking captured output into frames. Keeps
/// each `SidecarStreamFrame` payload bounded while still producing a monotonic
/// seq sequence (0,1,2...) for larger outputs.
const PTY_FRAME_PAYLOAD_BYTES: usize = 4 * 1024;

/// Stateless PTY allocator. Each `stream_open` (kind `pty`) maps to one
/// `alloc` call: openpty, spawn, drain, kill, frame. Sessions do not persist
/// across calls (unlike shell.session) because a PTY is tied to one child
/// process lifetime.
pub struct PtySessionStore;

impl PtySessionStore {
    pub fn new() -> Self {
        Self
    }

    /// Allocate a PTY, run `command`, and return the capped combined output.
    /// `command = None` or empty runs `sh -c ""` which exits immediately
    /// (useful for an alloc-failure / no-op probe).
    #[allow(clippy::too_many_arguments)]
    pub async fn alloc(
        &self,
        _session_id: &str,
        command: Option<&str>,
        cols: Option<u32>,
        rows: Option<u32>,
        cwd: Option<&str>,
        env: Option<&HashMap<String, String>>,
        timeout: Duration,
    ) -> Result<PtyRunOutcome> {
        let command = command.map(str::to_string);
        let cwd = cwd.map(str::to_string);
        let env = env.cloned();
        tokio::task::spawn_blocking(move || {
            run_pty_sync(
                command.as_deref(),
                cols,
                rows,
                cwd.as_deref(),
                env.as_ref(),
                timeout,
            )
        })
        .await
        .map_err(|e| anyhow!("pty task join failed: {e}"))?
    }
}

impl Default for PtySessionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct PtyRunOutcome {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub truncated: bool,
}

fn run_pty_sync(
    command: Option<&str>,
    cols: Option<u32>,
    rows: Option<u32>,
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    timeout: Duration,
) -> Result<PtyRunOutcome> {
    let pty_system = native_pty_system();
    let cols_u16 = u16::try_from(cols.unwrap_or(120).clamp(20, 400)).unwrap_or(120);
    let rows_u16 = u16::try_from(rows.unwrap_or(40).clamp(5, 200)).unwrap_or(40);
    let pair = pty_system
        .openpty(PtySize {
            rows: rows_u16,
            cols: cols_u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| anyhow!("failed to open pty: {e}"))?;

    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    cmd.arg(command.unwrap_or(""));
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    if let Some(env) = env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| anyhow!("failed to spawn pty command: {e}"))?;
    // Drop our slave handle so the child's inherited copy is the only remaining
    // reference; the master reader then EOFs when the child exits or is killed.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| anyhow!("failed to clone pty reader: {e}"))?;

    let capped = Arc::new(AtomicBool::new(false));
    let capped_for_thread = Arc::clone(&capped);
    let drain = std::thread::spawn(move || drain_pty_reader(reader, capped_for_thread));

    let start = Instant::now();
    let mut exit_code: Option<i32> = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(127));
                break;
            }
            Ok(None) => {}
            Err(e) => return Err(anyhow!("pty status check failed: {e}")),
        }
        if capped.load(Ordering::Relaxed) {
            break;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    // Kill (idempotent if already exited) so the reader hits EOF, then reap to
    // avoid a zombie. Errors are intentionally ignored: the outcome is already
    // determined by the wait loop above.
    let _ = child.kill();
    let _ = child.wait();

    let bytes = drain
        .join()
        .map_err(|_| anyhow!("pty drain thread panicked"))?;
    let truncated = capped.load(Ordering::Relaxed);
    let output = String::from_utf8_lossy(&bytes).into_owned();

    Ok(PtyRunOutcome {
        exit_code,
        output,
        timed_out,
        truncated,
    })
}

/// Reads the pty master until EOF or until `PTY_OUTPUT_CAP_BYTES` have been
/// captured. Sets `capped` once the cumulative cap is reached so the wait loop
/// can terminate the child promptly.
fn drain_pty_reader(mut reader: Box<dyn Read + Send>, capped: Arc<AtomicBool>) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let remaining = PTY_OUTPUT_CAP_BYTES.saturating_sub(buf.len());
                let take = n.min(remaining);
                if take > 0 {
                    buf.extend_from_slice(&chunk[..take]);
                }
                if buf.len() >= PTY_OUTPUT_CAP_BYTES {
                    capped.store(true, Ordering::Relaxed);
                    break;
                }
            }
            Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    buf
}

/// Builds the `SidecarStreamFrame` lines for a completed allocation. The
/// captured output is chunked into `PTY_FRAME_PAYLOAD_BYTES` frames with a
/// strictly increasing `seq` (0,1,2...); the final frame carries `end: true`
/// and, when relevant, an error marker (`output_truncated`, `timed_out`, or
/// `nonzero_exit:N`) so the receiver can distinguish clean completion from
/// truncation.
pub fn build_pty_frames(session_id: &str, outcome: &PtyRunOutcome) -> Result<Vec<String>> {
    let error_marker = pty_error_marker(outcome);
    if outcome.output.is_empty() {
        return Ok(vec![stream_frame_response(
            session_id,
            0,
            "",
            true,
            error_marker.as_deref(),
        )?]);
    }

    let mut frames = Vec::new();
    let mut seq = 0u64;
    let mut idx = 0usize;
    while idx < outcome.output.len() {
        let mut end_idx = (idx + PTY_FRAME_PAYLOAD_BYTES).min(outcome.output.len());
        // Back off to a UTF-8 char boundary so the slice stays on a char edge.
        while end_idx < outcome.output.len() && !outcome.output.is_char_boundary(end_idx) {
            end_idx -= 1;
        }
        if end_idx <= idx {
            // The whole window sits inside one oversized multibyte char (should
            // not happen at a 4KB window); step forward to guarantee progress.
            end_idx = outcome.output.len();
        }
        let chunk = &outcome.output[idx..end_idx];
        let is_last = end_idx >= outcome.output.len();
        let frame_error = if is_last { error_marker.as_deref() } else { None };
        frames.push(stream_frame_response(
            session_id,
            seq,
            chunk,
            is_last,
            frame_error,
        )?);
        seq += 1;
        idx = end_idx;
    }
    Ok(frames)
}

fn pty_error_marker(outcome: &PtyRunOutcome) -> Option<String> {
    if outcome.truncated {
        Some("output_truncated".to_string())
    } else if outcome.timed_out {
        Some("timed_out".to_string())
    } else if outcome.exit_code != Some(0) {
        Some(format!(
            "nonzero_exit:{}",
            outcome.exit_code.map_or(-1, |code| code)
        ))
    } else {
        None
    }
}

#[cfg(test)]
#[path = "pty_tests.rs"]
mod tests;
