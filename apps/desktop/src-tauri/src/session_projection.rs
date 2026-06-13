use crate::sessions::DesktopSessionLog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceTrustState {
    Trusted,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionTreeSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_trust: Option<WorkspaceTrustState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_leaf_id: Option<String>,
    pub entry_count: usize,
    pub branch_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_source_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_source_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionStats {
    pub event_count: usize,
    pub pending_approval_count: usize,
    pub blocked_run_count: usize,
    pub command_event_count: usize,
    pub diff_event_count: usize,
    pub tool_outcome_count: usize,
}

pub fn project_session_tree_summary(log: &DesktopSessionLog) -> Option<DesktopSessionTreeSummary> {
    let mut summary = MutableTreeSummary::default();

    for envelope in &log.envelopes {
        let Some(event) = envelope.get("event").and_then(Value::as_object) else {
            continue;
        };
        let Some(session_tree) = validated_session_tree(event) else {
            continue;
        };
        match session_tree {
            ProjectionSessionTree::Metadata {
                name,
                cwd,
                trusted_root,
                workspace_trust,
                parent_session_id,
            } => {
                assign_option_string(&mut summary.session_name, name);
                assign_option_string(&mut summary.cwd, cwd);
                assign_option_string(&mut summary.trusted_root, trusted_root);
                if workspace_trust.is_some() {
                    summary.workspace_trust = workspace_trust;
                }
                assign_option_string(&mut summary.parent_session_id, parent_session_id);
            }
            ProjectionSessionTree::Entry {
                entry_id,
                parent_entry_id,
                active,
            } => {
                summary.entries.insert(entry_id.clone());
                if active {
                    summary.active_leaf_id = Some(entry_id);
                }
                if let Some(parent_entry_id) = parent_entry_id {
                    summary.child_entry_ids.insert(parent_entry_id);
                }
            }
            ProjectionSessionTree::ActiveLeaf { entry_id } => {
                summary.active_leaf_id = Some(entry_id);
            }
            ProjectionSessionTree::Fork {
                parent_session_id,
                source,
            } => {
                assign_option_string(&mut summary.parent_session_id, parent_session_id);
                summary.fork_source_session_id = Some(source.session_id);
            }
            ProjectionSessionTree::Clone {
                parent_session_id,
                source,
            } => {
                assign_option_string(&mut summary.parent_session_id, parent_session_id);
                summary.clone_source_session_id = Some(source.session_id);
            }
        }
    }

    if summary.entries.is_empty()
        && summary.session_name.is_none()
        && summary.cwd.is_none()
        && summary.trusted_root.is_none()
        && summary.workspace_trust.is_none()
        && summary.parent_session_id.is_none()
        && summary.active_leaf_id.is_none()
        && summary.fork_source_session_id.is_none()
        && summary.clone_source_session_id.is_none()
    {
        return None;
    }

    let leaf_count = summary
        .entries
        .iter()
        .filter(|entry_id| !summary.child_entry_ids.contains(*entry_id))
        .count();
    Some(DesktopSessionTreeSummary {
        session_name: summary.session_name,
        cwd: summary.cwd,
        trusted_root: summary.trusted_root,
        workspace_trust: summary.workspace_trust,
        parent_session_id: summary.parent_session_id,
        active_leaf_id: summary.active_leaf_id,
        entry_count: summary.entries.len(),
        branch_count: if leaf_count > 0 {
            leaf_count
        } else {
            usize::from(!summary.entries.is_empty())
        },
        fork_source_session_id: summary.fork_source_session_id,
        clone_source_session_id: summary.clone_source_session_id,
    })
}

pub fn project_session_stats(log: &DesktopSessionLog) -> DesktopSessionStats {
    let mut approval_states = HashMap::<String, String>::new();
    let mut blocked_run_ids = HashSet::<String>::new();
    let mut command_event_count = 0;
    let mut diff_event_count = 0;
    let mut tool_outcome_count = 0;

    for envelope in &log.envelopes {
        let Some(event) = envelope.get("event").and_then(Value::as_object) else {
            continue;
        };
        if let Some(approval_record) = validated_approval_record(event) {
            approval_states.insert(approval_record.approval_id, approval_record.state);
        }
        if let Some(run) = validated_run(event) {
            if run.state == "blocked_on_approval" {
                blocked_run_ids.insert(run.run_id);
            } else {
                blocked_run_ids.remove(&run.run_id);
            }
        }
        if validated_command(event).is_some() {
            command_event_count += 1;
        }
        if validated_diff_files(event).is_some_and(|files| !files.is_empty()) {
            diff_event_count += 1;
        }
        if matches!(
            string_field(event, "type"),
            Some("tool.started" | "tool.completed" | "tool.failed")
        ) {
            tool_outcome_count += 1;
        }
    }

    DesktopSessionStats {
        event_count: log.envelopes.len(),
        pending_approval_count: approval_states
            .values()
            .filter(|state| state.as_str() == "pending")
            .count(),
        blocked_run_count: blocked_run_ids.len(),
        command_event_count,
        diff_event_count,
        tool_outcome_count,
    }
}

#[derive(Default)]
struct MutableTreeSummary {
    session_name: Option<String>,
    cwd: Option<String>,
    trusted_root: Option<String>,
    workspace_trust: Option<WorkspaceTrustState>,
    parent_session_id: Option<String>,
    active_leaf_id: Option<String>,
    fork_source_session_id: Option<String>,
    clone_source_session_id: Option<String>,
    entries: HashSet<String>,
    child_entry_ids: HashSet<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ProjectionSessionTree {
    Metadata {
        name: Option<String>,
        cwd: Option<String>,
        trusted_root: Option<String>,
        workspace_trust: Option<WorkspaceTrustState>,
        parent_session_id: Option<String>,
    },
    Entry {
        entry_id: String,
        parent_entry_id: Option<String>,
        active: bool,
    },
    ActiveLeaf {
        entry_id: String,
    },
    Fork {
        parent_session_id: Option<String>,
        source: ProjectionSessionSource,
    },
    Clone {
        parent_session_id: Option<String>,
        source: ProjectionSessionSource,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionSessionSource {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionApprovalRecord {
    approval_id: String,
    state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionRun {
    state: String,
    run_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ProjectionCommand {
    command: Vec<String>,
    cwd: String,
    status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionDiffFile {
    file_path: String,
}

fn assign_option_string(target: &mut Option<String>, value: Option<String>) {
    if let Some(value) = value {
        *target = Some(value);
    }
}

fn validated_session_tree(event: &serde_json::Map<String, Value>) -> Option<ProjectionSessionTree> {
    let event_type = string_field(event, "type")?;
    let session_tree = serde_json::from_value(event.get("sessionTree")?.clone()).ok()?;
    if session_tree_matches_event_type(event_type, &session_tree) {
        Some(session_tree)
    } else {
        None
    }
}

fn validated_approval_record(
    event: &serde_json::Map<String, Value>,
) -> Option<ProjectionApprovalRecord> {
    if !matches!(
        string_field(event, "type")?,
        "approval.requested" | "approval.updated" | "approval.blocked" | "approval.resumed"
    ) {
        return None;
    }
    serde_json::from_value(event.get("approvalRecord")?.clone()).ok()
}

fn validated_run(event: &serde_json::Map<String, Value>) -> Option<ProjectionRun> {
    if !matches!(
        string_field(event, "type")?,
        "run.command.received"
            | "run.started"
            | "run.completed"
            | "run.interrupted"
            | "run.idle"
            | "run.failed"
            | "run.blocked"
    ) {
        return None;
    }
    serde_json::from_value(event.get("run")?.clone()).ok()
}

fn validated_command(event: &serde_json::Map<String, Value>) -> Option<ProjectionCommand> {
    if !matches!(
        string_field(event, "type")?,
        "command.started" | "command.completed" | "command.failed" | "command.timed_out"
    ) {
        return None;
    }
    let command =
        serde_json::from_value::<ProjectionCommand>(event.get("command")?.clone()).ok()?;
    if command.command.is_empty() || command.cwd.is_empty() || command.status.is_empty() {
        return None;
    }
    Some(command)
}

fn validated_diff_files(event: &serde_json::Map<String, Value>) -> Option<Vec<ProjectionDiffFile>> {
    if !matches!(
        string_field(event, "type")?,
        "file.diff.proposed" | "file.diff.applied"
    ) {
        return None;
    }
    let files =
        serde_json::from_value::<Vec<ProjectionDiffFile>>(event.get("diffFiles")?.clone()).ok()?;
    if files.iter().any(|file| file.file_path.is_empty()) {
        return None;
    }
    Some(files)
}

fn string_field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn session_tree_matches_event_type(event_type: &str, session_tree: &ProjectionSessionTree) -> bool {
    match session_tree {
        ProjectionSessionTree::Metadata { .. } => event_type == "session.metadata.updated",
        ProjectionSessionTree::Entry { .. } => event_type == "session.tree.entry",
        ProjectionSessionTree::ActiveLeaf { .. } => event_type == "session.tree.active_leaf",
        ProjectionSessionTree::Fork { .. } => event_type == "session.forked",
        ProjectionSessionTree::Clone { .. } => event_type == "session.cloned",
    }
}
