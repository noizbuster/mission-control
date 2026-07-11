use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use tokio::sync::{Mutex, Notify};

pub struct ShellCancellationRegistry {
    active: Mutex<HashMap<String, Arc<Notify>>>,
}

impl ShellCancellationRegistry {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
        }
    }

    pub async fn register(&self, session_id: &str) -> Result<Arc<Notify>> {
        let mut active = self.active.lock().await;
        if active.contains_key(session_id) {
            return Err(anyhow!(
                "shell session already has an active command: {session_id}"
            ));
        }
        let cancellation = Arc::new(Notify::new());
        active.insert(session_id.to_string(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub async fn cancel(&self, session_id: &str) -> bool {
        let active = self.active.lock().await;
        let Some(cancellation) = active.get(session_id) else {
            return false;
        };
        cancellation.notify_one();
        true
    }

    pub async fn finish(&self, session_id: &str) {
        self.active.lock().await.remove(session_id);
    }
}

impl Default for ShellCancellationRegistry {
    fn default() -> Self {
        Self::new()
    }
}
