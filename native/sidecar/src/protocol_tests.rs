use super::{
    SidecarCommand, SidecarProtocolOptions, handshake_completed_response_for_version,
    iso_diffed_response, iso_resolved_response, parse_command_with_options,
    stream_frame_response, stream_frames_for_session, task_cancelled_response,
    task_completed_response, task_failed_response, task_progress_response,
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
        _ => {
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
        _ => {
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
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: false,
    };
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
        _ => {
            anyhow::bail!("expected handshake command");
        }
    }
    match cancel {
        SidecarCommand::CancelTask { id, payload } => {
            assert_eq!(id, "cancel_1");
            assert_eq!(payload.task_id, "task_1");
            assert_eq!(payload.reason, Some("user stopped task".to_string()));
        }
        _ => {
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
        SidecarProtocolOptions {
            enable_v2: true,
            enable_v3: false,
        },
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

#[test]
fn parses_v3_handshake_and_negotiates_shell_pty_iso_capabilities() -> anyhow::Result<()> {
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: true,
    };
    let command = parse_command_with_options(
        r#"{"type":"handshake","id":"handshake_v3","payload":{"protocolVersion":3,"clientName":"mission-control-core","requestedCapabilities":["shell.session","pty.alloc","iso.resolve"]}}"#,
        options,
    )?;
    let response = handshake_completed_response_for_version("handshake_v3", 3, options)?;

    match command {
        SidecarCommand::Handshake { id, payload } => {
            assert_eq!(id, "handshake_v3");
            assert_eq!(payload.protocol_version, 3);
            assert!(payload
                .requested_capabilities
                .as_ref()
                .is_some_and(|caps| caps.contains(&"shell.session".to_string())));
        }
        _ => anyhow::bail!("expected handshake command"),
    }
    assert_eq!(
        response,
        r#"{"type":"handshake_completed","id":"handshake_v3","protocolVersion":3,"capabilities":["task.run","task.cancel","shell.session","pty.alloc","iso.resolve"]}"#
    );
    Ok(())
}

#[test]
fn rejects_v3_handshake_without_v3_feature_flag() {
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: false,
    };
    let result = parse_command_with_options(
        r#"{"type":"handshake","id":"handshake_v3","payload":{"protocolVersion":3,"clientName":"mission-control-core"}}"#,
        options,
    );

    assert!(result.is_err());
}

#[test]
fn rejects_v3_stream_command_without_v3_feature_flag() {
    let result = parse_command_with_options(
        r#"{"type":"stream_open","id":"open_1","payload":{"sessionId":"s1","kind":"shell","command":"echo hi"}}"#,
        SidecarProtocolOptions {
            enable_v2: true,
            enable_v3: false,
        },
    );

    assert!(result.is_err());
}

#[test]
fn v1_and_v2_handshakes_still_work_with_v3_enabled() -> anyhow::Result<()> {
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: true,
    };

    let v1_response = handshake_completed_response_for_version("h1", 1, options)?;
    let v2_response = handshake_completed_response_for_version("h2", 2, options)?;

    assert_eq!(
        v1_response,
        r#"{"type":"handshake_completed","id":"h1","protocolVersion":1,"capabilities":["task.run"]}"#
    );
    assert_eq!(
        v2_response,
        r#"{"type":"handshake_completed","id":"h2","protocolVersion":2,"capabilities":["task.run","task.cancel"]}"#
    );
    Ok(())
}

#[test]
fn emits_stream_frames_with_monotonic_seq_and_terminal_end() -> anyhow::Result<()> {
    let frames = stream_frames_for_session("sess_a", &["frame_0", "frame_1", "frame_2"])?;

    assert_eq!(frames.len(), 3);

    assert_eq!(
        frames[0],
        r#"{"type":"stream_frame","sessionId":"sess_a","seq":0,"payload":"frame_0","end":false}"#
    );
    assert_eq!(
        frames[1],
        r#"{"type":"stream_frame","sessionId":"sess_a","seq":1,"payload":"frame_1","end":false}"#
    );
    assert_eq!(
        frames[2],
        r#"{"type":"stream_frame","sessionId":"sess_a","seq":2,"payload":"frame_2","end":true}"#
    );
    Ok(())
}

#[test]
fn serializes_stream_frame_with_error_and_terminal_end() -> anyhow::Result<()> {
    let frame = stream_frame_response("sess_b", 3, "", true, Some("process exited 1"))?;

    assert_eq!(
        frame,
        r#"{"type":"stream_frame","sessionId":"sess_b","seq":3,"payload":"","end":true,"error":"process exited 1"}"#
    );
    Ok(())
}

#[test]
fn emits_single_terminal_frame_for_single_payload() -> anyhow::Result<()> {
    let frames = stream_frames_for_session("sess_c", &["done"])?;

    assert_eq!(frames.len(), 1);
    assert_eq!(
        frames[0],
        r#"{"type":"stream_frame","sessionId":"sess_c","seq":0,"payload":"done","end":true}"#
    );
    Ok(())
}

#[test]
fn parses_stream_open_and_close_commands() -> anyhow::Result<()> {
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: true,
    };
    let open = parse_command_with_options(
        r#"{"type":"stream_open","id":"open_1","payload":{"sessionId":"s1","kind":"shell","command":"echo hi"}}"#,
        options,
    )?;
    let close = parse_command_with_options(
        r#"{"type":"stream_close","id":"close_1","payload":{"sessionId":"s1","reason":"cancelled"}}"#,
        options,
    )?;

    match open {
        SidecarCommand::StreamOpen { id, payload } => {
            assert_eq!(id, "open_1");
            assert_eq!(payload.session_id, "s1");
            assert_eq!(payload.kind, "shell");
            assert_eq!(payload.command.as_deref(), Some("echo hi"));
        }
        _ => anyhow::bail!("expected stream_open command"),
    }
    match close {
        SidecarCommand::StreamClose { id, payload } => {
            assert_eq!(id, "close_1");
            assert_eq!(payload.session_id, "s1");
            assert_eq!(payload.reason.as_deref(), Some("cancelled"));
        }
        _ => anyhow::bail!("expected stream_close command"),
    }
    Ok(())
}

#[test]
fn parses_iso_resolve_and_diff_commands() -> anyhow::Result<()> {
    let options = SidecarProtocolOptions {
        enable_v2: true,
        enable_v3: true,
    };
    let resolve = parse_command_with_options(
        r#"{"type":"iso_resolve","id":"iso_1","payload":{"target":"/workspace"}}"#,
        options,
    )?;
    let diff = parse_command_with_options(
        r#"{"type":"iso_diff","id":"iso_2","payload":{"target":"/workspace","baseline":"a","current":"b"}}"#,
        options,
    )?;

    match resolve {
        SidecarCommand::IsoResolve { id, payload } => {
            assert_eq!(id, "iso_1");
            assert_eq!(payload.target, "/workspace");
        }
        _ => anyhow::bail!("expected iso_resolve command"),
    }
    match diff {
        SidecarCommand::IsoDiff { id, payload } => {
            assert_eq!(id, "iso_2");
            assert_eq!(payload.baseline, "a");
            assert_eq!(payload.current, "b");
        }
        _ => anyhow::bail!("expected iso_diff command"),
    }
    Ok(())
}

#[test]
fn serializes_iso_resolve_and_diff_responses() -> anyhow::Result<()> {
    let resolved = iso_resolved_response("iso_1", "/resolved/path", Some("bind"))?;
    let diffed = iso_diffed_response("iso_2", "-a\n+b", false)?;

    assert_eq!(
        resolved,
        r#"{"type":"iso_resolved","id":"iso_1","payload":{"resolved":"/resolved/path","method":"bind"}}"#
    );
    assert_eq!(
        diffed,
        r#"{"type":"iso_diffed","id":"iso_2","payload":{"diff":"-a\n+b","identical":false}}"#
    );
    Ok(())
}
