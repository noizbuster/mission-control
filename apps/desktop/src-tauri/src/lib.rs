mod desktop_command_bridge;
mod desktop_command_bridge_stream;
mod desktop_commands;
mod session_catalog;
mod session_datetime;
mod session_index;
mod session_index_format;
mod session_index_format_fields;
mod session_index_format_records;
mod session_log_scan;
mod session_parse;
mod session_protocol;
mod sessions;

pub use desktop_commands::{
    DesktopApprovalDecisionInput, DesktopCommandReceipt, DesktopPromptCommandInput,
    DesktopProviderCredentialSummary, DesktopRunCommandInput, SaveDesktopProviderCredentialInput,
    decide_approval, interrupt_run, list_provider_credentials, queue_follow_up, resume_run,
    save_provider_credential, steer_run, submit_prompt,
};
pub use sessions::{
    DesktopSessionLog, DesktopSessionSnapshot, DesktopSessionSummary, SessionLockState,
    SessionLogState, list_sessions_in_data_dir, read_session_events_from_data_dir,
    read_session_snapshot_from_data_dir,
};

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn greet(name: &str) -> String {
    format!("hello {name}")
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn list_sessions() -> Result<Vec<DesktopSessionSummary>, String> {
    let data_dir = sessions::resolve_data_dir().map_err(|error| error.to_string())?;
    sessions::list_sessions_in_data_dir(&data_dir).map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn read_session_events(session_id: &str) -> Result<DesktopSessionLog, String> {
    let data_dir = sessions::resolve_data_dir().map_err(|error| error.to_string())?;
    sessions::read_session_events_from_data_dir(&data_dir, session_id)
        .map_err(|error| error.to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn read_session_snapshot(session_id: &str) -> Result<DesktopSessionSnapshot, String> {
    let data_dir = sessions::resolve_data_dir().map_err(|error| error.to_string())?;
    sessions::read_session_snapshot_from_data_dir(&data_dir, session_id)
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
pub fn run() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            list_sessions,
            read_session_events,
            read_session_snapshot,
            submit_prompt,
            queue_follow_up,
            steer_run,
            interrupt_run,
            resume_run,
            decide_approval,
            list_provider_credentials,
            save_provider_credential
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("mission-control desktop failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(feature = "tauri-runtime"))]
pub fn run() {}

#[cfg(test)]
mod desktop_command_approval_tests;

#[cfg(test)]
mod desktop_command_tests;

#[cfg(test)]
mod desktop_command_run_owner_tests;

#[cfg(test)]
mod session_log_invariant_tests;

#[cfg(test)]
mod session_index_fallback_tests;

#[cfg(test)]
mod session_index_security_tests;

#[cfg(test)]
mod session_index_shape_tests;

#[cfg(test)]
mod session_list_tests;

#[cfg(test)]
mod session_read_validation_tests;

#[cfg(test)]
mod tests {
    use super::{
        DesktopApprovalDecisionInput, DesktopPromptCommandInput, DesktopRunCommandInput,
        SessionLogState, decide_approval, greet, interrupt_run, queue_follow_up,
        read_session_events_from_data_dir, resume_run, steer_run, submit_prompt,
    };
    use crate::sessions::override_data_dir_for_test;
    use std::error::Error;
    use std::fs::remove_dir_all;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn greet_returns_expected_string() {
        assert_eq!(greet("mission-control"), "hello mission-control");
    }

    #[test]
    fn write_command_handlers_return_typed_receipts() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("public-command-handlers")?;
        let _override_dir = override_data_dir_for_test(data_dir.clone())?;
        let prompt = DesktopPromptCommandInput {
            session_id: "session_write".to_owned(),
            prompt: "desktop prompt".to_owned(),
            model_provider_selection: None,
            parent_message_id: None,
            resume: None,
        };
        let run = DesktopRunCommandInput {
            session_id: "session_write".to_owned(),
            reason: Some("manual stop".to_owned()),
        };
        let decision = DesktopApprovalDecisionInput {
            session_id: "session_write".to_owned(),
            approval_id: "approval_permission_call_patch".to_owned(),
            state: "approved".to_owned(),
            reason: Some("approved".to_owned()),
        };

        let queued = queue_follow_up(prompt.clone())?;
        let resumed = resume_run(run.clone())?;
        let submitted = submit_prompt(prompt.clone())?;
        let steered = steer_run(prompt)?;
        let interrupted = interrupt_run(run)?;
        let decided = decide_approval(decision)?;
        let log = read_session_events_from_data_dir(&data_dir, "session_write")?;

        assert_eq!(submitted.status, "completed");
        assert_eq!(queued.status, "queued");
        assert_eq!(steered.status, "completed");
        assert_eq!(resumed.status, "completed");
        assert_eq!(interrupted.status, "idle");
        assert_eq!(decided.status, "idle");
        assert!(submitted.events_written > 0);
        assert!(queued.events_written > 0);
        assert!(steered.events_written > 0);
        assert!(resumed.events_written > 0);
        assert!(interrupted.events_written > 0);
        assert_eq!(decided.events_written, 0);
        assert_eq!(log.state, SessionLogState::Available);
        assert!(!log.envelopes.is_empty());
        remove_dir_all(data_dir)?;
        Ok(())
    }

    fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
    }
}
