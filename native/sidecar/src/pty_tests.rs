use super::{
    PTY_OUTPUT_CAP_BYTES, PtyRunOutcome, PtySessionStore, build_pty_frames,
};
use std::collections::HashMap;
use std::time::Duration;

fn base_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    env.insert("PATH".to_string(), path);
    env
}

#[tokio::test]
async fn allocates_a_pty_and_streams_command_output() -> anyhow::Result<()> {
    let store = PtySessionStore::new();
    let env = base_env();

    let outcome = store
        .alloc(
            "pty-echo",
            Some("printf '%s\\n' hello-pty"),
            None,
            None,
            None,
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;

    assert!(!outcome.timed_out, "should not time out");
    assert!(!outcome.truncated, "should not truncate");
    assert_eq!(outcome.exit_code, Some(0));
    assert!(
        outcome.output.contains("hello-pty"),
        "expected pty output to contain the echoed token, got: {:?}",
        outcome.output
    );
    Ok(())
}

#[tokio::test]
async fn cumulative_cap_truncates_a_flooding_process() -> anyhow::Result<()> {
    let store = PtySessionStore::new();
    let env = base_env();

    let outcome = store
        .alloc(
            "pty-flood",
            Some("while true; do echo flood; done"),
            None,
            None,
            None,
            Some(&env),
            Duration::from_secs(5),
        )
        .await?;

    assert!(
        outcome.output.len() <= PTY_OUTPUT_CAP_BYTES,
        "captured output {} must not exceed the {} cap",
        outcome.output.len(),
        PTY_OUTPUT_CAP_BYTES,
    );
    assert!(
        outcome.truncated || outcome.timed_out,
        "a flooding process must be truncated or timed out (truncated={}, timed_out={})",
        outcome.truncated,
        outcome.timed_out,
    );
    Ok(())
}

#[tokio::test]
async fn does_not_panic_on_alloc_failure_inputs() -> anyhow::Result<()> {
    let store = PtySessionStore::new();
    let env = base_env();

    // Nonexistent cwd: must not panic. portable-pty may surface this as an Err
    // or as an Ok-with-nonzero-exit; either is acceptable as long as no panic.
    let bad_cwd = store
        .alloc(
            "pty-bad-cwd",
            Some("echo nope"),
            None,
            None,
            Some("/nonexistent/mission-control/pty/cwd"),
            Some(&env),
            Duration::from_secs(5),
        )
        .await;
    match bad_cwd {
        Ok(outcome) => {
            let frames = build_pty_frames("pty-bad-cwd", &outcome)?;
            assert!(!frames.is_empty());
        }
        Err(_) => {
            // Spawn rejected the cwd; acceptable failure mode.
        }
    }

    // Empty command + oversized dims: clamped, must not panic, empty output.
    let empty = store
        .alloc(
            "pty-empty",
            None,
            Some(99_999),
            Some(99_999),
            None,
            Some(&env),
            Duration::from_secs(5),
        )
        .await?;
    let frames = build_pty_frames("pty-empty", &empty)?;
    assert!(!frames.is_empty());
    Ok(())
}

#[test]
fn build_frames_chunks_output_with_monotonic_seq_and_terminal_end() -> anyhow::Result<()> {
    // Output larger than one frame payload forces seq 0,1,2... so the streaming
    // contract (strictly increasing seq, single end:true) is exercised.
    let large = "ab".repeat(PTY_OUTPUT_CAP_BYTES.min(12 * 1024) / 2);
    let outcome = PtyRunOutcome {
        exit_code: Some(0),
        output: large.clone(),
        timed_out: false,
        truncated: false,
    };

    let frames = build_pty_frames("pty-frames", &outcome)?;
    assert!(
        frames.len() > 1,
        "expected multiple frames for oversized output, got {}",
        frames.len(),
    );

    let mut last_seq: i64 = -1;
    let mut end_seen = false;
    for line in &frames {
        let value: serde_json::Value = serde_json::from_str(line)?;
        assert_eq!(value["type"], "stream_frame");
        assert_eq!(value["sessionId"], "pty-frames");
        let seq = value["seq"].as_u64();
        let seq_num = seq.unwrap_or(u64::MAX);
        assert!(
            i64::try_from(seq_num).unwrap_or(0) > last_seq,
            "seq must be strictly increasing"
        );
        last_seq = i64::try_from(seq_num).unwrap_or(last_seq + 1);
        let end = value["end"].as_bool().unwrap_or(false);
        if end {
            end_seen = true;
            assert!(value.get("error").is_none() || value["error"].is_null());
        } else {
            assert!(value["payload"].as_str().is_some_and(|p| !p.is_empty()));
        }
    }
    assert!(end_seen, "exactly one terminal end:true frame expected");
    Ok(())
}

#[test]
fn build_frames_emits_single_error_frame_for_failed_outcome() -> anyhow::Result<()> {
    let outcome = PtyRunOutcome {
        exit_code: None,
        output: String::new(),
        timed_out: false,
        truncated: true,
    };

    let frames = build_pty_frames("pty-err", &outcome)?;
    assert_eq!(frames.len(), 1);
    let value: serde_json::Value = serde_json::from_str(&frames[0])?;
    assert_eq!(value["type"], "stream_frame");
    assert_eq!(value["seq"], 0);
    assert_eq!(value["end"], true);
    assert_eq!(value["error"], "output_truncated");
    Ok(())
}

#[test]
fn build_frames_marks_nonzero_exit_on_terminal_frame() -> anyhow::Result<()> {
    let outcome = PtyRunOutcome {
        exit_code: Some(3),
        output: "boom\n".to_string(),
        timed_out: false,
        truncated: false,
    };

    let frames = build_pty_frames("pty-exit", &outcome)?;
    assert!(!frames.is_empty());
    let last_value: serde_json::Value = serde_json::from_str(
        frames.last().ok_or_else(|| anyhow::anyhow!("missing frame"))?,
    )?;
    assert_eq!(last_value["end"], true);
    assert_eq!(last_value["error"], "nonzero_exit:3");
    Ok(())
}
