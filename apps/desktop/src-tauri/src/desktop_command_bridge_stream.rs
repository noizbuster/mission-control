use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

type PendingSender = mpsc::Sender<Result<Value, String>>;
type PendingMap = Arc<Mutex<HashMap<u64, PendingSender>>>;

pub(crate) struct DesktopCommandBridgeStream {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: PendingMap,
    next_id: AtomicU64,
    timeout: Duration,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamBridgeRequest<'a, T> {
    id: u64,
    action: &'static str,
    input: &'a T,
    data_dir: &'a str,
    workspace_root: &'a str,
}

#[derive(Deserialize)]
struct StreamBridgeResponse {
    id: u64,
    result: Option<Value>,
    error: Option<String>,
}

impl DesktopCommandBridgeStream {
    pub(crate) fn spawn(
        node_executable: String,
        script_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut child = Command::new(&node_executable)
            .arg(&script_path)
            .arg("--stream")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start desktop command stream bridge: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "desktop command stream bridge stdin is unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "desktop command stream bridge stdout is unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "desktop command stream bridge stderr is unavailable".to_owned())?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        spawn_stdout_reader(stdout, Arc::clone(&pending));
        spawn_stderr_drain(stderr);
        Ok(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending,
            next_id: AtomicU64::new(1),
            timeout,
        })
    }

    pub(crate) fn invoke<T: Serialize>(
        &self,
        action: &'static str,
        input: &T,
        data_dir: &str,
        workspace_root: &str,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.insert_pending(id, sender)?;
        let request = StreamBridgeRequest {
            id,
            action,
            input,
            data_dir,
            workspace_root,
        };
        let mut request_json = serde_json::to_vec(&request).map_err(|error| {
            format!("could not serialize desktop stream command request: {error}")
        })?;
        request_json.push(b'\n');
        if let Err(error) = self.write_request(&request_json) {
            self.remove_pending(id);
            return Err(error);
        }
        match receiver.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(id);
                Err("desktop command stream bridge timed out".to_owned())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.remove_pending(id);
                Err("desktop command stream bridge closed before response".to_owned())
            }
        }
    }

    fn insert_pending(&self, id: u64, sender: PendingSender) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "desktop command stream pending map is poisoned".to_owned())?;
        pending.insert(id, sender);
        Ok(())
    }

    fn remove_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    fn write_request(&self, request_json: &[u8]) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "desktop command stream stdin is poisoned".to_owned())?;
        stdin
            .write_all(request_json)
            .and_then(|()| stdin.flush())
            .map_err(|error| format!("could not write desktop stream command request: {error}"))
    }
}

impl Drop for DesktopCommandBridgeStream {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_stdout_reader(stdout: ChildStdout, pending: PendingMap) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(payload) => dispatch_response(&pending, &payload),
                Err(error) => {
                    drain_pending(
                        &pending,
                        format!("desktop command stream bridge read failed: {error}"),
                    );
                    return;
                }
            }
        }
        drain_pending(&pending, "desktop command stream bridge exited".to_owned());
    });
}

fn dispatch_response(pending: &PendingMap, payload: &str) {
    let response = match serde_json::from_str::<StreamBridgeResponse>(payload) {
        Ok(response) => response,
        Err(_) => return,
    };
    let sender = match pending.lock() {
        Ok(mut pending) => pending.remove(&response.id),
        Err(_) => None,
    };
    if let Some(sender) = sender {
        let _ = sender.send(response_result(response));
    }
}

fn response_result(response: StreamBridgeResponse) -> Result<Value, String> {
    if let Some(error) = response.error {
        return Err(error);
    }
    response
        .result
        .ok_or_else(|| "desktop command stream response omitted result".to_owned())
}

fn drain_pending(pending: &PendingMap, message: String) {
    let senders = match pending.lock() {
        Ok(mut pending) => pending
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    for sender in senders {
        let _ = sender.send(Err(message.clone()));
    }
}

fn spawn_stderr_drain(stderr: ChildStderr) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => {}
                Err(_) => return,
            }
        }
    });
}
