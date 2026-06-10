use crate::sessions::SessionDiagnostic;
use std::collections::HashSet;

#[derive(Default)]
pub(crate) struct EventLogScan {
    previous_sequence: Option<u64>,
    seen_event_ids: HashSet<String>,
}

impl EventLogScan {
    pub(crate) fn accept(
        &mut self,
        event_id: &str,
        sequence: u64,
        line_number: usize,
    ) -> Result<(), SessionDiagnostic> {
        if self
            .previous_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(diagnostic(
                "event sequence is not strictly increasing",
                line_number,
            ));
        }
        if self.seen_event_ids.contains(event_id) {
            return Err(diagnostic("event id is duplicated", line_number));
        }
        self.previous_sequence = Some(sequence);
        self.seen_event_ids.insert(event_id.to_owned());
        Ok(())
    }
}

fn diagnostic(message: &str, line_number: usize) -> SessionDiagnostic {
    SessionDiagnostic {
        code: "corrupt_line".to_owned(),
        message: message.to_owned(),
        line_number: Some(line_number),
    }
}
