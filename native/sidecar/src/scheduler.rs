use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::{
    SidecarCommand, SidecarProtocolOptions, handshake_completed_response_for_version,
    iso_diffed_response, iso_resolved_response, parse_command_with_options,
    stream_frame_response, stream_frames_for_session, task_cancelled_response,
    task_completed_response, task_failed_response, task_progress_response,
};
use crate::pty::PtySessionStore;
use crate::shell::ShellSessionStore;

pub async fn run() -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();
    let protocol_options = SidecarProtocolOptions::from_env();
    let shell_store = ShellSessionStore::new();
    let pty_store = PtySessionStore::new();

    while let Some(line) = lines.next_line().await? {
        let command = parse_command_with_options(&line, protocol_options)?;
        match command {
            SidecarCommand::Handshake { id, payload } => {
                let response = handshake_completed_response_for_version(
                    &id,
                    payload.protocol_version,
                    protocol_options,
                )?;
                write_line(&mut stdout, &response).await?;
            }
            SidecarCommand::RunTask { id, payload } => {
                if payload.label == "fail" {
                    let response = task_failed_response(
                        &id,
                        "sidecar_failed",
                        "task label requested failure",
                        Some(false),
                    )?;
                    write_line(&mut stdout, &response).await?;
                    continue;
                }

                for progress in [0.25_f64, 0.5_f64, 0.75_f64] {
                    let response = task_progress_response(&id, progress)?;
                    write_line(&mut stdout, &response).await?;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }

                let response = task_completed_response(&id, "completed by rust sidecar")?;
                write_line(&mut stdout, &response).await?;
            }
            SidecarCommand::CancelTask { payload, .. } => {
                let reason = payload.reason.as_deref().unwrap_or("task cancelled");
                let response = task_cancelled_response(&payload.task_id, reason)?;
                write_line(&mut stdout, &response).await?;
            }
            SidecarCommand::StreamOpen { payload, .. } => {
                if payload.kind == "shell" {
                    handle_shell_stream(&shell_store, &payload, &mut stdout).await?;
                } else if payload.kind == "pty" {
                    handle_pty_stream(&pty_store, &payload, &mut stdout).await?;
                } else {
                    let frames = stream_frames_for_session(
                        &payload.session_id,
                        &["frame_0", "frame_1", "frame_2"],
                    )?;
                    for frame in frames {
                        write_line(&mut stdout, &frame).await?;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
            SidecarCommand::StreamClose { payload, .. } => {
                let response = stream_frame_response(
                    &payload.session_id,
                    0,
                    "",
                    true,
                    payload.reason.as_deref(),
                )?;
                write_line(&mut stdout, &response).await?;
            }
            SidecarCommand::IsoResolve { id, payload } => {
                let resolution = crate::iso::resolve(&payload.target, payload.method.as_deref());
                let response = iso_resolved_response(
                    &id,
                    &resolution.resolved,
                    resolution.method.as_deref(),
                )?;
                write_line(&mut stdout, &response).await?;
            }
            SidecarCommand::IsoDiff { id, payload } => {
                let outcome = crate::iso::diff(&payload.baseline, &payload.current);
                let response = iso_diffed_response(&id, &outcome.diff, outcome.identical)?;
                write_line(&mut stdout, &response).await?;
            }
        }
    }

    // Overlay mounts have no explicit iso.stop command in the protocol; this is
    // their only teardown path (stdin EOF = host closed the session).
    crate::iso::cleanup_mounts();
    Ok(())
}

async fn handle_shell_stream<W>(
    store: &ShellSessionStore,
    payload: &crate::protocol::SidecarStreamOpenPayload,
    stdout: &mut W,
) -> anyhow::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let command = payload.command.as_deref().unwrap_or("");
    let timeout = payload
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(crate::shell::DEFAULT_TIMEOUT);
    let outcome = store
        .run(
            &payload.session_id,
            command,
            payload.cwd.as_deref(),
            payload.env.as_ref(),
            timeout,
        )
        .await;

    let frames = frames_for_shell_outcome(&payload.session_id, outcome)?;
    for frame in frames {
        write_line(stdout, &frame).await?;
    }
    Ok(())
}

async fn handle_pty_stream<W>(
    store: &PtySessionStore,
    payload: &crate::protocol::SidecarStreamOpenPayload,
    stdout: &mut W,
) -> anyhow::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let timeout = payload
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(crate::pty::DEFAULT_TIMEOUT);
    let outcome = store
        .alloc(
            &payload.session_id,
            payload.command.as_deref(),
            payload.cols,
            payload.rows,
            payload.cwd.as_deref(),
            payload.env.as_ref(),
            timeout,
        )
        .await;

    let frames = match outcome {
        Ok(result) => crate::pty::build_pty_frames(&payload.session_id, &result)?,
        Err(error) => {
            let frame = stream_frame_response(
                &payload.session_id,
                0,
                "",
                true,
                Some(&format!("pty_alloc_failed: {error}")),
            )?;
            vec![frame]
        }
    };
    for frame in frames {
        write_line(stdout, &frame).await?;
    }
    Ok(())
}

fn frames_for_shell_outcome(
    session_id: &str,
    outcome: anyhow::Result<crate::shell::ShellRunOutcome>,
) -> anyhow::Result<Vec<String>> {
    match outcome {
        Ok(result) => {
            let failed = result.exit_code.unwrap_or(1) != 0;
            if result.output.is_empty() {
                let error = if result.timed_out {
                    Some("timed_out".to_string())
                } else if failed {
                    Some(format!("nonzero_exit:{}", result.exit_code.map_or(-1, |c| c)))
                } else {
                    None
                };
                let frame = stream_frame_response(
                    session_id,
                    0,
                    "",
                    true,
                    error.as_deref(),
                )?;
                Ok(vec![frame])
            } else {
                let first = stream_frame_response(session_id, 0, &result.output, false, None)?;
                let trailer_error = if result.timed_out {
                    Some("timed_out".to_string())
                } else if failed {
                    Some(format!("nonzero_exit:{}", result.exit_code.map_or(-1, |c| c)))
                } else {
                    None
                };
                let trailer_payload = if result.timed_out { "\n[timed out]" } else { "" };
                let trailer = stream_frame_response(
                    session_id,
                    1,
                    trailer_payload,
                    true,
                    trailer_error.as_deref(),
                )?;
                Ok(vec![first, trailer])
            }
        }
        Err(error) => {
            let frame = stream_frame_response(
                session_id,
                0,
                "",
                true,
                Some(&format!("shell_run_failed: {error}")),
            )?;
            Ok(vec![frame])
        }
    }
}

async fn write_line<W: tokio::io::AsyncWrite + Unpin>(stdout: &mut W, line: &str) -> anyhow::Result<()> {
    stdout.write_all(line.as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}
