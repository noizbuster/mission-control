#![cfg_attr(not(any(test, windows)), allow(dead_code))]

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SESSION_CONTROL_PROXY_MODE: &str = "session-control-proxy";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SessionControlProxyBootstrap {
    pub registry_dir: String,
    pub registry_path: String,
    pub nonce: String,
    pub pipe_random: String,
    pub owner_id: String,
    pub epoch: u64,
    pub pid: u32,
    pub process_start_id: String,
    pub heartbeat_wall_ms: u64,
    pub expires_wall_ms: u64,
}

#[derive(Serialize)]
struct SessionControlRegistry<'a> {
    endpoint: &'a str,
    nonce: &'a str,
    owner_id: &'a str,
    epoch: u64,
    pid: u32,
    process_start_id: &'a str,
    heartbeat_wall_ms: u64,
    expires_wall_ms: u64,
}

pub fn proxy_mode_requested(args: impl Iterator<Item = String>) -> anyhow::Result<bool> {
    let arguments = args.collect::<Vec<_>>();
    match arguments.as_slice() {
        [] => Ok(false),
        [mode] if mode == SESSION_CONTROL_PROXY_MODE => Ok(true),
        [mode, ..] if mode == SESSION_CONTROL_PROXY_MODE => {
            anyhow::bail!("session-control-proxy accepts no positional arguments")
        }
        _ => Ok(false),
    }
}

pub async fn run_proxy() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let (bootstrap, stdin) = read_bootstrap().await?;
        crate::session_control_pipe_windows::run_proxy(bootstrap, stdin).await
    }
    #[cfg(not(windows))]
    {
        anyhow::bail!("session-control-proxy is only available on Windows")
    }
}

pub(crate) fn parse_bootstrap(line: &str) -> anyhow::Result<SessionControlProxyBootstrap> {
    let bootstrap: SessionControlProxyBootstrap = serde_json::from_str(line)?;
    validate_bootstrap(&bootstrap)?;
    Ok(bootstrap)
}

pub(crate) fn pipe_name(bootstrap: &SessionControlProxyBootstrap) -> String {
    format!(
        r"\\.\pipe\mission-control-{}-{}",
        bootstrap.pipe_random, bootstrap.nonce
    )
}

pub(crate) fn registry_json(
    bootstrap: &SessionControlProxyBootstrap,
    endpoint: &str,
) -> anyhow::Result<String> {
    Ok(serde_json::to_string(&SessionControlRegistry {
        endpoint,
        nonce: &bootstrap.nonce,
        owner_id: &bootstrap.owner_id,
        epoch: bootstrap.epoch,
        pid: bootstrap.pid,
        process_start_id: &bootstrap.process_start_id,
        heartbeat_wall_ms: bootstrap.heartbeat_wall_ms,
        expires_wall_ms: bootstrap.expires_wall_ms,
    })?)
}

fn validate_bootstrap(bootstrap: &SessionControlProxyBootstrap) -> anyhow::Result<()> {
    if bootstrap.registry_dir.is_empty()
        || bootstrap.registry_path.is_empty()
        || Path::new(&bootstrap.registry_path).parent() != Some(Path::new(&bootstrap.registry_dir))
        || !is_base64url(&bootstrap.nonce, 43)
        || !is_base64url(&bootstrap.pipe_random, 22)
        || bootstrap.owner_id.is_empty()
        || bootstrap.epoch == 0
        || bootstrap.process_start_id.is_empty()
        || bootstrap.expires_wall_ms <= bootstrap.heartbeat_wall_ms
    {
        anyhow::bail!("invalid session control proxy bootstrap")
    }
    Ok(())
}

fn is_base64url(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(windows)]
async fn read_bootstrap() -> anyhow::Result<(
    SessionControlProxyBootstrap,
    tokio::io::BufReader<tokio::io::Stdin>,
)> {
    use tokio::io::AsyncBufReadExt;

    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    let read = stdin.read_line(&mut line).await?;
    if read == 0 {
        anyhow::bail!("session control proxy bootstrap is required")
    }
    Ok((parse_bootstrap(line.trim_end())?, stdin))
}

#[cfg(test)]
#[path = "session_control_pipe_tests.rs"]
mod tests;
