use crate::desktop_command_bridge_stream::DesktopCommandBridgeStream;
use crate::desktop_commands::DesktopCommandReceipt;
use serde::Serialize;
use serde::de::DeserializeOwned;
#[cfg(test)]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
#[cfg(test)]
use std::thread::sleep;
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;

const DEFAULT_NODE_EXECUTABLE: &str = "node";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct DesktopCommandBridge {
    workspace_root: PathBuf,
    transport: DesktopCommandBridgeTransport,
}

#[derive(Clone)]
enum DesktopCommandBridgeTransport {
    #[cfg(test)]
    OneShot(DesktopCommandBridgeOneShot),
    Stream(Arc<DesktopCommandBridgeStream>),
}

#[cfg(test)]
#[derive(Clone)]
struct DesktopCommandBridgeOneShot {
    node_executable: String,
    script_path: PathBuf,
    timeout: Duration,
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest<'a, T> {
    action: &'static str,
    input: &'a T,
    data_dir: &'a str,
    workspace_root: &'a str,
}

impl DesktopCommandBridge {
    pub(crate) fn default() -> Result<Self, String> {
        let workspace_root =
            std::env::current_dir().map_err(|error| format!("could not resolve cwd: {error}"))?;
        Ok(Self {
            workspace_root,
            transport: DesktopCommandBridgeTransport::Stream(shared_default_stream()?),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_script_path(script_path: PathBuf) -> Result<Self, String> {
        let workspace_root =
            std::env::current_dir().map_err(|error| format!("could not resolve cwd: {error}"))?;
        Ok(Self {
            workspace_root,
            transport: DesktopCommandBridgeTransport::OneShot(DesktopCommandBridgeOneShot {
                node_executable: node_executable(),
                script_path,
                timeout: DEFAULT_TIMEOUT,
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_workspace_root(workspace_root: PathBuf) -> Result<Self, String> {
        Ok(Self {
            workspace_root,
            transport: DesktopCommandBridgeTransport::Stream(Arc::new(
                DesktopCommandBridgeStream::spawn(
                    node_executable(),
                    default_script_path(),
                    DEFAULT_TIMEOUT,
                )?,
            )),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_stream_script_path(
        script_path: PathBuf,
        workspace_root: PathBuf,
    ) -> Result<Self, String> {
        Ok(Self {
            workspace_root,
            transport: DesktopCommandBridgeTransport::Stream(Arc::new(
                DesktopCommandBridgeStream::spawn(node_executable(), script_path, DEFAULT_TIMEOUT)?,
            )),
        })
    }

    pub(crate) fn invoke<T: Serialize>(
        &self,
        action: &'static str,
        input: &T,
        data_dir: &Path,
    ) -> Result<DesktopCommandReceipt, String> {
        self.invoke_json(action, input, data_dir)
    }

    pub(crate) fn invoke_json<T: Serialize, R: DeserializeOwned>(
        &self,
        action: &'static str,
        input: &T,
        data_dir: &Path,
    ) -> Result<R, String> {
        let data_dir = path_to_string(data_dir)?;
        let workspace_root = path_to_string(&self.workspace_root)?;
        match &self.transport {
            #[cfg(test)]
            DesktopCommandBridgeTransport::OneShot(one_shot) => {
                invoke_one_shot(one_shot, action, input, &data_dir, &workspace_root)
            }
            DesktopCommandBridgeTransport::Stream(stream) => {
                let value = stream.invoke(action, input, &data_dir, &workspace_root)?;
                serde_json::from_value(value).map_err(|error| {
                    format!("could not parse desktop stream bridge output: {error}")
                })
            }
        }
    }
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))
}

fn node_executable() -> String {
    std::env::var("MISSION_CONTROL_NODE").unwrap_or_else(|_| DEFAULT_NODE_EXECUTABLE.to_owned())
}

fn default_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("desktop-command-service.mjs")
}

fn shared_default_stream() -> Result<Arc<DesktopCommandBridgeStream>, String> {
    static DEFAULT_STREAM: OnceLock<Result<Arc<DesktopCommandBridgeStream>, String>> =
        OnceLock::new();
    DEFAULT_STREAM
        .get_or_init(|| {
            DesktopCommandBridgeStream::spawn(
                node_executable(),
                default_script_path(),
                DEFAULT_TIMEOUT,
            )
            .map(Arc::new)
        })
        .clone()
}

#[cfg(test)]
fn invoke_one_shot<T: Serialize, R: DeserializeOwned>(
    one_shot: &DesktopCommandBridgeOneShot,
    action: &'static str,
    input: &T,
    data_dir: &str,
    workspace_root: &str,
) -> Result<R, String> {
    let request = BridgeRequest {
        action,
        input,
        data_dir,
        workspace_root,
    };
    let request_json = serde_json::to_vec(&request)
        .map_err(|error| format!("could not serialize desktop command request: {error}"))?;
    let output = run_node_bridge(one_shot, &request_json)?;
    if !output.status.success() {
        return Err(format!(
            "desktop command bridge failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("could not parse desktop command bridge output: {error}"))
}

#[cfg(test)]
fn run_node_bridge(
    one_shot: &DesktopCommandBridgeOneShot,
    request_json: &[u8],
) -> Result<std::process::Output, String> {
    let mut child = Command::new(&one_shot.node_executable)
        .arg(&one_shot.script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start desktop command bridge: {error}"))?;
    let Some(mut stdin) = child.stdin.take() else {
        return Err("desktop command bridge stdin is unavailable".to_owned());
    };
    stdin
        .write_all(request_json)
        .map_err(|error| format!("could not write desktop command request: {error}"))?;
    drop(stdin);

    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("could not poll desktop command bridge: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("could not read desktop command bridge output: {error}"));
        }
        if started.elapsed() > one_shot.timeout {
            let _ = child.kill();
            let _ = child.wait_with_output();
            return Err("desktop command bridge timed out".to_owned());
        }
        sleep(Duration::from_millis(10));
    }
}
