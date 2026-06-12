use crate::desktop_commands::{DesktopPromptCommandInput, DesktopRunCommandInput};
use crate::sessions::{SessionLogState, read_session_events_from_data_dir};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all};
use std::path::PathBuf;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn desktop_interrupt_attaches_to_active_run() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("run-owner-interrupt")?;
    let workspace_root = temp_data_dir("run-owner-interrupt-workspace")?;
    create_dir_all(&workspace_root)?;
    let script_path = fixture_script_path();
    let bridge = crate::desktop_command_bridge::DesktopCommandBridge::with_stream_script_path(
        script_path,
        workspace_root.clone(),
    )?;
    let session_id = "session_desktop_active_interrupt";
    let prompt = prompt_input(session_id);
    let run = DesktopRunCommandInput {
        session_id: session_id.to_owned(),
        reason: Some("desktop stop".to_owned()),
    };
    let submit_bridge = bridge.clone();
    let submit_data_dir = data_dir.clone();
    let submit_thread =
        thread::spawn(move || submit_bridge.invoke("submitPrompt", &prompt, &submit_data_dir));

    let started = bridge
        .invoke("waitStarted", &run, &data_dir)
        .map_err(command_error)?;
    let interrupted = bridge
        .invoke("interruptRun", &run, &data_dir)
        .map_err(command_error)?;
    let submit_receipt = match submit_thread.join() {
        Ok(result) => result.map_err(command_error)?,
        Err(_) => return Err(command_error("submit thread panicked".to_owned())),
    };
    let log = read_session_events_from_data_dir(&data_dir, session_id)?;

    assert_eq!(started.status, "completed");
    assert_eq!(interrupted.status, "interrupted");
    assert_eq!(submit_receipt.status, "interrupted");
    assert_eq!(log.state, SessionLogState::Available);
    assert!(event_types(&log).contains(&"run.interrupted".to_owned()));
    assert!(!event_types(&log).contains(&"run.completed".to_owned()));
    remove_dir_all(data_dir)?;
    remove_dir_all(workspace_root)?;
    Ok(())
}

#[test]
fn desktop_interrupts_approval_wait() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("approval-wait-interrupt")?;
    let workspace_root = temp_data_dir("approval-wait-workspace")?;
    create_dir_all(&workspace_root)?;
    let bridge =
        crate::desktop_command_bridge::DesktopCommandBridge::with_workspace_root(workspace_root)?;
    let session_id = "session_desktop_approval_interrupt";
    let prompt = DesktopPromptCommandInput {
        session_id: session_id.to_owned(),
        prompt: "deterministic patch should wait on approval".to_owned(),
        model_provider_selection: Some(serde_json::json!({
            "providerID": "local",
            "modelID": "local-echo"
        })),
        parent_message_id: None,
        resume: None,
    };
    let run = DesktopRunCommandInput {
        session_id: session_id.to_owned(),
        reason: Some("desktop stop while approval is pending".to_owned()),
    };

    let submitted = bridge
        .invoke("submitPrompt", &prompt, &data_dir)
        .map_err(command_error)?;
    let interrupted = bridge
        .invoke("interruptRun", &run, &data_dir)
        .map_err(command_error)?;
    let log = read_session_events_from_data_dir(&data_dir, session_id)?;
    let events = event_types(&log);

    assert_eq!(submitted.status, "blocked_on_approval");
    assert_ne!(interrupted.status, "failed");
    assert!(interrupted.events_written > 0);
    assert_eq!(log.state, SessionLogState::Available);
    assert!(events.contains(&"approval.requested".to_owned()));
    assert!(events.contains(&"run.blocked".to_owned()));
    assert!(run_commands(&log).contains(&"interrupt".to_owned()));
    assert!(approval_states(&log).contains(&"pending".to_owned()));
    remove_dir_all(data_dir)?;
    Ok(())
}

fn prompt_input(session_id: &str) -> DesktopPromptCommandInput {
    DesktopPromptCommandInput {
        session_id: session_id.to_owned(),
        prompt: "hold the desktop provider open".to_owned(),
        model_provider_selection: None,
        parent_message_id: None,
        resume: None,
    }
}

fn event_types(log: &crate::sessions::DesktopSessionLog) -> Vec<String> {
    log.envelopes
        .iter()
        .filter_map(|envelope| {
            envelope
                .get("event")
                .and_then(|event| event.get("type"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn run_commands(log: &crate::sessions::DesktopSessionLog) -> Vec<String> {
    log.envelopes
        .iter()
        .filter_map(|envelope| {
            envelope
                .get("event")
                .and_then(|event| event.get("run"))
                .and_then(|run| run.get("command"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn approval_states(log: &crate::sessions::DesktopSessionLog) -> Vec<String> {
    log.envelopes
        .iter()
        .filter_map(|envelope| {
            envelope
                .get("event")
                .and_then(|event| event.get("approvalRecord"))
                .and_then(|approval| approval.get("state"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn fixture_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("test-fixtures")
        .join("desktop-stream-command-service.mjs")
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}

fn command_error(error: String) -> Box<dyn Error> {
    Box::new(std::io::Error::other(error))
}
