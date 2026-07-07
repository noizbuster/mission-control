import { describe, expect, it } from 'vitest';
import { type CliSessionCatalogEntry, formatSessionCatalogEntry } from './session-catalog.js';

describe('session awaiting list formatting', () => {
    it('formats compact reason and source metadata', () => {
        // Given: public catalog entries for every awaiting reason plus legacy non-awaiting statuses.
        const entries: readonly CliSessionCatalogEntry[] = [
            catalogEntry('session_idle', 'idle'),
            catalogEntry('session_running', 'running'),
            catalogEntry('session_stopped', 'stopped'),
            catalogEntry('session_failed', 'failed'),
            catalogEntry('session_approval', 'awaiting', {
                reason: 'approval',
                source: { approvalId: 'approval_patch', runId: 'run_1', toolCallId: 'patch_call' },
            }),
            catalogEntry('session_input', 'awaiting', {
                reason: 'user_input',
                source: { runId: 'run_plan' },
            }),
            catalogEntry('session_subagent', 'awaiting', {
                reason: 'subagent',
                source: { jobId: 'job_child', childSessionId: 'session_child' },
            }),
        ];

        // When: the list-row formatter renders the public entries.
        const rows = entries.map(formatSessionCatalogEntry);

        // Then: existing statuses are unchanged and awaiting rows include deterministic source copy.
        expect(rows.slice(0, 4).map((row) => row.split('\t')[1])).toEqual([
            'status=idle',
            'status=running',
            'status=stopped',
            'status=failed',
        ]);
        expect(rows[4]).toContain('status=awaiting approval (approval=approval_patch,run=run_1,tool=patch_call)');
        expect(rows[5]).toContain('status=awaiting user input (run=run_plan)');
        expect(rows[6]).toContain('status=awaiting subagent (job=job_child,child=session_child)');
    });
});

function catalogEntry(
    sessionId: string,
    status: CliSessionCatalogEntry['status'],
    awaiting?: CliSessionCatalogEntry['awaiting'],
): CliSessionCatalogEntry {
    return {
        sessionId,
        status,
        eventCount: 1,
        messageCount: 1,
        trustStatus: 'unknown',
        diagnostics: [],
        ...(awaiting !== undefined ? { awaiting } : {}),
    };
}
