use crate::desktop_commands::DesktopCommandReceipt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const DEFAULT_NODE_EXECUTABLE: &str = "node";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub(crate) struct DesktopCommandBridge {
    node_executable: String,
    script_path: PathBuf,
    workspace_root: PathBuf,
    timeout: Duration,
}

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
            node_executable: std::env::var("MISSION_CONTROL_NODE")
                .unwrap_or_else(|_| DEFAULT_NODE_EXECUTABLE.to_owned()),
            script_path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("desktop-command-service.mjs"),
            workspace_root,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_script_path(script_path: PathBuf) -> Result<Self, String> {
        let mut bridge = Self::default()?;
        bridge.script_path = script_path;
        Ok(bridge)
    }

    #[cfg(test)]
    pub(crate) fn with_workspace_root(workspace_root: PathBuf) -> Result<Self, String> {
        let mut bridge = Self::default()?;
        bridge.workspace_root = workspace_root;
        Ok(bridge)
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
        let request = BridgeRequest {
            action,
            input,
            data_dir: &data_dir,
            workspace_root: &workspace_root,
        };
        let request_json = serde_json::to_vec(&request)
            .map_err(|error| format!("could not serialize desktop command request: {error}"))?;
        let output = self.run_node_bridge(&request_json)?;
        if !output.status.success() {
            return Err(format!(
                "desktop command bridge failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("could not parse desktop command bridge output: {error}"))
    }

    fn run_node_bridge(&self, request_json: &[u8]) -> Result<std::process::Output, String> {
        let mut child = Command::new(&self.node_executable)
            .arg(&self.script_path)
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
                return child.wait_with_output().map_err(|error| {
                    format!("could not read desktop command bridge output: {error}")
                });
            }
            if started.elapsed() > self.timeout {
                let _ = child.kill();
                let _ = child.wait_with_output();
                return Err("desktop command bridge timed out".to_owned());
            }
            sleep(Duration::from_millis(10));
        }
    }
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))
}
