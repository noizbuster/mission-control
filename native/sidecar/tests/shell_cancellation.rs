use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn real_sidecar_cancellation_terminates_the_external_command() -> anyhow::Result<()> {
    let fixture = tempfile::TempDir::new()?;
    let marker = fixture.path().join("late-marker");
    let command = format!("sleep 1; touch '{}'", marker.display());
    let mut child = Command::new(env!("CARGO_BIN_EXE_mission-control-sidecar"))
        .env("MCTRL_SIDECAR_V2", "1")
        .env("MCTRL_SIDECAR_V3", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("missing sidecar stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("missing sidecar stdout"))?;
    let mut stdout = BufReader::new(stdout);

    writeln!(
        stdin,
        r#"{{"type":"handshake","id":"handshake","payload":{{"protocolVersion":3,"clientName":"test","requestedCapabilities":["shell.session"]}}}}"#,
    )?;
    stdin.flush()?;
    let mut line = String::new();
    stdout.read_line(&mut line)?;
    assert!(line.contains("handshake_completed"));

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "type": "stream_open",
            "id": "open",
            "payload": {
                "sessionId": "real-cancel",
                "kind": "shell",
                "command": command,
                "timeoutMs": 30_000
            }
        })
    )?;
    stdin.flush()?;
    thread::sleep(Duration::from_millis(100));
    stdin.write_all(
        br#"{"type":"stream_close","id":"close","payload":{"sessionId":"real-cancel","reason":"operator_aborted"}}
"#,
    )?;
    stdin.flush()?;

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut terminal = String::new();
    while Instant::now() < deadline {
        line.clear();
        if stdout.read_line(&mut line)? == 0 {
            break;
        }
        if line.contains(r#""sessionId":"real-cancel""#) && line.contains(r#""end":true"#) {
            terminal = line.clone();
            break;
        }
    }
    assert!(
        terminal.contains(r#""error":"interrupted""#),
        "terminal frame: {terminal}"
    );
    thread::sleep(Duration::from_millis(1_200));
    assert!(
        !marker.exists(),
        "cancelled command created its delayed marker"
    );

    drop(stdin);
    let status = child.wait()?;
    assert!(status.success());
    Ok(())
}
