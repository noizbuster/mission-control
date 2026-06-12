use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::{
    SidecarCommand, SidecarProtocolOptions, handshake_completed_response_for_version,
    parse_command_with_options, task_cancelled_response, task_completed_response,
    task_failed_response, task_progress_response,
};

pub async fn run() -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();
    let protocol_options = SidecarProtocolOptions::from_env();

    while let Some(line) = lines.next_line().await? {
        let command = parse_command_with_options(&line, protocol_options)?;
        match command {
            SidecarCommand::Handshake { id, payload } => {
                let response = handshake_completed_response_for_version(
                    &id,
                    payload.protocol_version,
                    protocol_options,
                )?;
                stdout.write_all(response.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            SidecarCommand::RunTask { id, payload } => {
                if payload.label == "fail" {
                    let response = task_failed_response(
                        &id,
                        "sidecar_failed",
                        "task label requested failure",
                        Some(false),
                    )?;
                    stdout.write_all(response.as_bytes()).await?;
                    stdout.write_all(b"\n").await?;
                    stdout.flush().await?;
                    continue;
                }

                for progress in [0.25_f64, 0.5_f64, 0.75_f64] {
                    let response = task_progress_response(&id, progress)?;
                    stdout.write_all(response.as_bytes()).await?;
                    stdout.write_all(b"\n").await?;
                    stdout.flush().await?;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }

                let response = task_completed_response(&id, "completed by rust sidecar")?;
                stdout.write_all(response.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            SidecarCommand::CancelTask { payload, .. } => {
                let reason = match payload.reason.as_deref() {
                    Some(reason) => reason,
                    None => "task cancelled",
                };
                let response = task_cancelled_response(&payload.task_id, reason)?;
                stdout.write_all(response.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
        }
    }

    Ok(())
}
