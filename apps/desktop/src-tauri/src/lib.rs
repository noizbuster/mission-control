mod desktop_command_bridge;
mod desktop_command_bridge_stream;
mod desktop_commands;
mod session_datetime;
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
    DesktopSessionLog, DesktopSessionSnapshot, DesktopSessionSummary, SessionLogState,
    list_sessions_in_data_dir, read_session_events_from_data_dir,
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
mod tests {
    use super::{
        DesktopApprovalDecisionInput, DesktopPromptCommandInput, DesktopRunCommandInput,
        SessionLogState, decide_approval, greet, interrupt_run, list_sessions_in_data_dir,
        queue_follow_up, read_session_events_from_data_dir, resume_run, steer_run, submit_prompt,
    };
    use crate::sessions::override_data_dir_for_test;
    use std::error::Error;
    use std::fs::{create_dir_all, remove_dir_all, write};
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

    #[test]
    fn lists_sessions_and_reads_valid_events() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("valid")?;
        create_dir_all(data_dir.join("sessions"))?;
        write(
            data_dir.join("sessions").join("session_valid.jsonl"),
            session_log(
                "session_valid",
                &[
                    r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_valid","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_valid","message":"done"}}"#,
                ],
            ),
        )?;

        let sessions = list_sessions_in_data_dir(&data_dir)?;
        let log = read_session_events_from_data_dir(&data_dir, "session_valid")?;

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session_valid");
        assert_eq!(sessions[0].state, SessionLogState::Available);
        assert_eq!(sessions[0].event_count, 1);
        assert_eq!(log.envelopes.len(), 1);
        assert_eq!(log.state, SessionLogState::Available);
        remove_dir_all(data_dir)?;
        Ok(())
    }

    #[test]
    fn corrupt_session_returns_valid_prefix_and_diagnostic() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("corrupt")?;
        create_dir_all(data_dir.join("sessions"))?;
        write(
            data_dir.join("sessions").join("session_corrupt.jsonl"),
            format!(
                "{}{}",
                session_log(
                    "session_corrupt",
                    &[
                        r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_corrupt","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_corrupt","message":"done"}}"#
                    ],
                ),
                "{bad json\n",
            ),
        )?;

        let log = read_session_events_from_data_dir(&data_dir, "session_corrupt")?;

        assert_eq!(log.state, SessionLogState::Corrupt);
        assert_eq!(log.envelopes.len(), 1);
        assert_eq!(log.diagnostics.len(), 1);
        assert_eq!(log.diagnostics[0].line_number, Some(3));
        remove_dir_all(data_dir)?;
        Ok(())
    }

    #[test]
    fn schema_invalid_envelope_returns_diagnostic() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("invalid-envelope")?;
        create_dir_all(data_dir.join("sessions"))?;
        write(
            data_dir.join("sessions").join("session_invalid.jsonl"),
            session_log("session_invalid", &[r#"{"eventId":"event_1"}"#]),
        )?;

        let log = read_session_events_from_data_dir(&data_dir, "session_invalid")?;

        assert_eq!(log.state, SessionLogState::Corrupt);
        assert_eq!(log.envelopes.len(), 0);
        assert_eq!(log.diagnostics.len(), 1);
        assert_eq!(log.diagnostics[0].line_number, Some(2));
        remove_dir_all(data_dir)?;
        Ok(())
    }

    #[test]
    fn schema_invalid_envelope_enum_values_return_diagnostic() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("invalid-envelope-enum")?;
        create_dir_all(data_dir.join("sessions"))?;
        write(
            data_dir.join("sessions").join("session_invalid_enum.jsonl"),
            session_log(
                "session_invalid_enum",
                &[
                    r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_invalid_enum","durability":"archived","event":{"type":"task.unknown","timestamp":"not-a-date"}}"#,
                ],
            ),
        )?;

        let log = read_session_events_from_data_dir(&data_dir, "session_invalid_enum")?;

        assert_eq!(log.state, SessionLogState::Corrupt);
        assert_eq!(log.envelopes.len(), 0);
        assert_eq!(log.diagnostics.len(), 1);
        assert_eq!(log.diagnostics[0].line_number, Some(2));
        remove_dir_all(data_dir)?;
        Ok(())
    }

    #[test]
    fn missing_session_is_non_crashing_state() -> Result<(), Box<dyn Error>> {
        let data_dir = temp_data_dir("missing")?;

        let log = read_session_events_from_data_dir(&data_dir, "session_missing")?;

        assert_eq!(log.state, SessionLogState::Missing);
        assert_eq!(log.envelopes.len(), 0);
        assert_eq!(log.diagnostics.len(), 0);
        if data_dir.exists() {
            remove_dir_all(data_dir)?;
        }
        Ok(())
    }

    fn session_log(session_id: &str, event_records: &[&str]) -> String {
        let mut output = format!(
            "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n",
            session_id,
        );
        for event_record in event_records {
            output.push_str(&format!(
                "{{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{}}}\n",
                event_record,
            ));
        }
        output
    }

    fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
    }
}
