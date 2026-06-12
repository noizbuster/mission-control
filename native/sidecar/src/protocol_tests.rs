use super::{
    SidecarCommand, SidecarProtocolOptions, handshake_completed_response_for_version,
    parse_command_with_options, task_cancelled_response, task_completed_response,
    task_failed_response, task_progress_response,
};

#[test]
fn parses_run_task_command_with_payload() -> anyhow::Result<()> {
    let command = parse_command_with_options(
        r#"{"type":"run_task","id":"task_1","payload":{"label":"demo"}}"#,
        SidecarProtocolOptions::default(),
    )?;

    match command {
        SidecarCommand::RunTask { id, payload } => {
            assert_eq!(id, "task_1");
            assert_eq!(payload.label, "demo");
        }
        SidecarCommand::Handshake { .. } | SidecarCommand::CancelTask { .. } => {
            anyhow::bail!("expected run task command");
        }
    }
    Ok(())
}

#[test]
fn parses_handshake_command_and_serializes_capabilities() -> anyhow::Result<()> {
    let command = parse_v1_command(
        r#"{"type":"handshake","id":"handshake_1","payload":{"protocolVersion":1,"clientName":"mission-control-core"}}"#,
    )?;
    let response = handshake_completed_response_for_version(
        "handshake_1",
        1,
        SidecarProtocolOptions::default(),
    )?;

    match command {
        SidecarCommand::Handshake { id, payload } => {
            assert_eq!(id, "handshake_1");
            assert_eq!(payload.protocol_version, 1);
            assert_eq!(payload.client_name, "mission-control-core");
        }
        SidecarCommand::RunTask { .. } | SidecarCommand::CancelTask { .. } => {
            anyhow::bail!("expected handshake command");
        }
    }
    assert_eq!(
        response,
        r#"{"type":"handshake_completed","id":"handshake_1","protocolVersion":1,"capabilities":["task.run"]}"#
    );
    Ok(())
}

#[test]
fn rejects_v2_cancel_capability_without_feature_flag() {
    let command = parse_v1_command(
        r#"{"type":"handshake","id":"handshake_2","payload":{"protocolVersion":2,"clientName":"mission-control-core","requestedCapabilities":["task.cancel"]}}"#,
    );
    let cancel =
        parse_v1_command(r#"{"type":"cancel_task","id":"cancel_1","payload":{"taskId":"task_1"}}"#);

    assert!(command.is_err());
    assert!(cancel.is_err());
}

#[test]
fn parses_v2_cancel_command_when_feature_flagged() -> anyhow::Result<()> {
    let options = SidecarProtocolOptions { enable_v2: true };
    let command = parse_command_with_options(
        r#"{"type":"handshake","id":"handshake_2","payload":{"protocolVersion":2,"clientName":"mission-control-core","requestedCapabilities":["task.cancel"]}}"#,
        options,
    )?;
    let cancel = parse_command_with_options(
        r#"{"type":"cancel_task","id":"cancel_1","payload":{"taskId":"task_1","reason":"user stopped task"}}"#,
        options,
    )?;
    let response = handshake_completed_response_for_version("handshake_2", 2, options)?;

    match command {
        SidecarCommand::Handshake { id, payload } => {
            assert_eq!(id, "handshake_2");
            assert_eq!(payload.protocol_version, 2);
            assert_eq!(
                payload.requested_capabilities,
                Some(vec!["task.cancel".to_string()])
            );
        }
        SidecarCommand::RunTask { .. } | SidecarCommand::CancelTask { .. } => {
            anyhow::bail!("expected handshake command");
        }
    }
    match cancel {
        SidecarCommand::CancelTask { id, payload } => {
            assert_eq!(id, "cancel_1");
            assert_eq!(payload.task_id, "task_1");
            assert_eq!(payload.reason, Some("user stopped task".to_string()));
        }
        SidecarCommand::Handshake { .. } | SidecarCommand::RunTask { .. } => {
            anyhow::bail!("expected cancel command");
        }
    }
    assert_eq!(
        response,
        r#"{"type":"handshake_completed","id":"handshake_2","protocolVersion":2,"capabilities":["task.run","task.cancel"]}"#
    );
    Ok(())
}

#[test]
fn rejects_unknown_v2_capability_even_when_feature_flagged() {
    let command = parse_command_with_options(
        r#"{"type":"handshake","id":"handshake_2","payload":{"protocolVersion":2,"clientName":"mission-control-core","requestedCapabilities":["process.exec"]}}"#,
        SidecarProtocolOptions { enable_v2: true },
    );

    assert!(command.is_err());
}

fn parse_v1_command(input: &str) -> anyhow::Result<SidecarCommand> {
    parse_command_with_options(input, SidecarProtocolOptions::default())
}

#[test]
fn serializes_progress_completion_failure_and_cancel_responses() -> anyhow::Result<()> {
    let progress = task_progress_response("task_1", 0.5)?;
    let completed = task_completed_response("task_1", "completed by rust sidecar")?;
    let failed = task_failed_response(
        "task_1",
        "sidecar_failed",
        "provider process exited",
        Some(false),
    )?;
    let cancelled = task_cancelled_response("task_1", "user stopped task")?;

    assert_eq!(
        progress,
        r#"{"type":"task_progress","id":"task_1","progress":0.5}"#
    );
    assert_eq!(
        completed,
        r#"{"type":"task_completed","id":"task_1","result":{"message":"completed by rust sidecar"}}"#
    );
    assert_eq!(
        failed,
        r#"{"type":"task_failed","id":"task_1","error":{"code":"sidecar_failed","message":"provider process exited","retryable":false}}"#
    );
    assert_eq!(
        cancelled,
        r#"{"type":"task_cancelled","id":"task_1","reason":"user stopped task"}"#
    );
    Ok(())
}
