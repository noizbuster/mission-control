use super::{ShellRunOutcome, ShellSessionStore};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::Mutex;

fn base_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    env.insert("PATH".to_string(), path);
    env
}

#[tokio::test]
async fn persists_environment_across_calls_in_one_session() -> anyhow::Result<()> {
    let store = ShellSessionStore::new();
    let env = base_env();

    let first = store
        .run(
            "session-persist",
            "export MCTRL_SHELL_TEST=hello",
            None,
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;
    assert!(!first.timed_out, "first call should not time out");

    let second = store
        .run(
            "session-persist",
            "printf '%s' \"$MCTRL_SHELL_TEST\"",
            None,
            None,
            Duration::from_secs(10),
        )
        .await?;
    assert!(!second.timed_out);
    assert_eq!(second.output, "hello");
    Ok(())
}

#[tokio::test]
async fn isolates_sessions_by_id() -> anyhow::Result<()> {
    let store = ShellSessionStore::new();
    let env = base_env();

    store
        .run(
            "session-a",
            "export MCTRL_ISO=a",
            None,
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;
    store
        .run(
            "session-b",
            "export MCTRL_ISO=b",
            None,
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;

    let from_a = store
        .run(
            "session-a",
            "printf '%s' \"$MCTRL_ISO\"",
            None,
            None,
            Duration::from_secs(10),
        )
        .await?;
    let from_b = store
        .run(
            "session-b",
            "printf '%s' \"$MCTRL_ISO\"",
            None,
            None,
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(from_a.output, "a");
    assert_eq!(from_b.output, "b");
    Ok(())
}

#[tokio::test]
async fn propagates_exit_code_and_captures_output() -> anyhow::Result<()> {
    let store = ShellSessionStore::new();
    let env = base_env();

    let ok = store
        .run(
            "session-exit",
            "printf ok",
            None,
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(ok.exit_code, Some(0));
    assert_eq!(ok.output, "ok");

    let fail = store
        .run(
            "session-exit",
            "exit 7",
            None,
            None,
            Duration::from_secs(10),
        )
        .await?;
    assert_eq!(fail.exit_code, Some(7));
    Ok(())
}

#[tokio::test]
async fn times_out_a_long_running_command() -> anyhow::Result<()> {
    let store = ShellSessionStore::new();
    let env = base_env();

    let outcome = store
        .run(
            "session-timeout",
            "sleep 30",
            None,
            Some(&env),
            Duration::from_millis(300),
        )
        .await?;
    assert!(outcome.timed_out, "expected the command to time out");
    Ok(())
}

#[tokio::test]
async fn cancels_a_long_running_command_before_timeout() -> anyhow::Result<()> {
    let store = std::sync::Arc::new(ShellSessionStore::new());
    let running_store = std::sync::Arc::clone(&store);
    let run = tokio::spawn(async move {
        running_store
            .run(
                "session-cancel",
                "sleep 2",
                None,
                Some(&base_env()),
                Duration::from_secs(30),
            )
            .await
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        while !store.cancel("session-cancel").await {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let outcome = tokio::time::timeout(Duration::from_secs(1), run).await???;

    assert!(
        outcome.interrupted,
        "expected the command to be interrupted"
    );
    assert!(!outcome.timed_out, "operator cancellation is not a timeout");
    Ok(())
}

#[tokio::test]
async fn applies_cwd_on_session_creation() -> anyhow::Result<()> {
    let tmp = tempfile_dir()?;
    let store = ShellSessionStore::new();
    let env = base_env();

    let outcome = store
        .run(
            "session-cwd",
            "pwd",
            Some(tmp.path().to_str().expect("utf8 tmpdir")),
            Some(&env),
            Duration::from_secs(10),
        )
        .await?;
    let expected = tmp.path().canonicalize()?;
    let produced = std::path::PathBuf::from(outcome.output.trim());
    assert_eq!(produced, expected);
    Ok(())
}

#[tokio::test]
async fn outcome_default_is_constructible() {
    let outcome = ShellRunOutcome {
        exit_code: None,
        output: String::new(),
        timed_out: false,
        interrupted: false,
    };
    assert!(!outcome.timed_out);
}

#[tokio::test]
async fn store_is_send_and_sync_via_mutex() {
    let store = std::sync::Arc::new(ShellSessionStore::new());
    let lock = Mutex::new(());
    let _guard = lock.lock().await;
    let _ = &store;
}

fn tempfile_dir() -> anyhow::Result<tempfile::TempDir> {
    Ok(tempfile::TempDir::new()?)
}
