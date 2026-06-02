use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::{parse_command, task_completed_response, task_progress_response};

pub async fn run() -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let command = parse_command(&line)?;
        if command.r#type == "run_task" {
            for progress in [0.25_f64, 0.5_f64, 0.75_f64] {
                let response = task_progress_response(&command.id, progress)?;
                stdout.write_all(response.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }

            let response = task_completed_response(&command.id, "completed by rust sidecar")?;
            stdout.write_all(response.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }

    Ok(())
}
