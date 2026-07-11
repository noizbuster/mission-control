use super::{
    SESSION_CONTROL_PROXY_MODE, parse_bootstrap, pipe_name, proxy_mode_requested, registry_json,
};

const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PIPE_RANDOM: &str = "BBBBBBBBBBBBBBBBBBBBBB";

fn bootstrap_json() -> String {
    format!(
        r#"{{"registry_dir":"/control/db","registry_path":"/control/db/session.json","nonce":"{NONCE}","pipe_random":"{PIPE_RANDOM}","owner_id":"owner-one","epoch":7,"pid":42,"process_start_id":"process-start","heartbeat_wall_ms":1000,"expires_wall_ms":16000}}"#
    )
}

#[test]
fn recognizes_only_the_exact_proxy_mode() -> anyhow::Result<()> {
    assert!(!proxy_mode_requested(std::iter::empty())?);
    assert!(proxy_mode_requested(
        [SESSION_CONTROL_PROXY_MODE.to_string()].into_iter()
    )?);
    assert!(
        proxy_mode_requested(
            [SESSION_CONTROL_PROXY_MODE.to_string(), "extra".to_string()].into_iter()
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn builds_a_random_nonce_tagged_pipe_name() -> anyhow::Result<()> {
    let bootstrap = parse_bootstrap(&bootstrap_json())?;

    assert_eq!(
        pipe_name(&bootstrap),
        format!(r"\\.\pipe\mission-control-{PIPE_RANDOM}-{NONCE}")
    );
    Ok(())
}

#[test]
fn serializes_the_exact_ordered_registry_contract() -> anyhow::Result<()> {
    let bootstrap = parse_bootstrap(&bootstrap_json())?;
    let endpoint = pipe_name(&bootstrap);

    assert_eq!(
        registry_json(&bootstrap, &endpoint)?,
        format!(
            r#"{{"endpoint":"\\\\.\\pipe\\mission-control-{PIPE_RANDOM}-{NONCE}","nonce":"{NONCE}","owner_id":"owner-one","epoch":7,"pid":42,"process_start_id":"process-start","heartbeat_wall_ms":1000,"expires_wall_ms":16000}}"#
        )
    );
    Ok(())
}

#[test]
fn rejects_unknown_bootstrap_fields_without_reflecting_nonce() {
    let malformed = bootstrap_json().replace(
        "\"expires_wall_ms\":16000",
        "\"expires_wall_ms\":16000,\"secret\":true",
    );
    let error = parse_bootstrap(&malformed)
        .err()
        .map(|value| value.to_string());

    assert!(error.is_some());
    assert!(!error.unwrap_or_default().contains(NONCE));
}

#[test]
fn locks_the_windows_security_and_atomic_publication_contract() {
    let manifest = include_str!("../Cargo.toml");
    let pipe_source = include_str!("session_control_pipe_windows.rs");
    let security_source = include_str!("session_control_pipe_windows_security.rs");

    for feature in [
        "Win32_Foundation",
        "Win32_Security",
        "Win32_Security_Authorization",
        "Win32_Storage_FileSystem",
        "Win32_System_Memory",
        "Win32_System_Pipes",
        "Win32_System_Threading",
    ] {
        assert!(manifest.contains(feature));
    }
    for required in [
        "PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED",
        "PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS",
        "FlushFileBuffers(handle)",
        "MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH",
        "input = read_proxy_command",
        "tokio::select!",
        "client_connected",
        "client_closed",
        "ProxyCommand::HostData",
        "pipe.disconnect()",
        "MAX_PROXY_COMMAND_BYTES",
        "read_proxy_command(stdin",
        "read_until(b'\\n'",
    ] {
        assert!(pipe_source.contains(required));
    }
    assert!(security_source.contains("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})"));
    assert!(security_source.contains("SetNamedSecurityInfoW"));
}
