import type { SessionAwaitingDetails, SessionStatus } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    formatAwaitingSource,
    formatSessionStatusLabel,
    formatSessionStatusWithSource,
} from './session-status-format.js';

describe('session status formatting', () => {
    it.each([
        ['idle', 'idle'],
        ['running', 'running'],
        ['stopped', 'stopped'],
        ['failed', 'failed'],
    ] satisfies readonly (readonly [
        SessionStatus,
        string,
    ])[])('keeps existing %s display copy unchanged', (status, expected) => {
        // Given: an existing non-awaiting lifecycle status.
        const input = { status };

        // When: the shared display formatter is applied.
        const label = formatSessionStatusLabel(input);
        const labelWithSource = formatSessionStatusWithSource(input);

        // Then: legacy row text remains byte-stable.
        expect(label).toBe(expected);
        expect(labelWithSource).toBe(expected);
    });

    it.each([
        [
            'approval',
            {
                reason: 'approval',
                source: { approvalId: 'approval_patch', runId: 'run_1', toolCallId: 'patch_call' },
            },
            'awaiting approval',
            'approval=approval_patch,run=run_1,tool=patch_call',
        ],
        [
            'user input',
            { reason: 'user_input', source: { inputId: 'operator_prompt' } },
            'awaiting user input',
            'input=operator_prompt',
        ],
        [
            'subagent',
            { reason: 'subagent', source: { jobId: 'job_child', childSessionId: 'session_child' } },
            'awaiting subagent',
            'job=job_child,child=session_child',
        ],
    ] satisfies readonly (readonly [
        string,
        SessionAwaitingDetails,
        string,
        string,
    ])[])('formats awaiting %s reason and source deterministically', (_name, awaiting, expectedLabel, expectedSource) => {
        // Given: an awaiting status with protocol source metadata.
        const input = { status: 'awaiting' as const, awaiting };

        // When: compact display strings are produced.
        const label = formatSessionStatusLabel(input);
        const source = formatAwaitingSource(awaiting);
        const full = formatSessionStatusWithSource(input);

        // Then: reason and source use stable lowercase copy and field order.
        expect(label).toBe(expectedLabel);
        expect(source).toBe(expectedSource);
        expect(full).toBe(`${expectedLabel} (${expectedSource})`);
    });

    it('falls back to compact awaiting copy for malformed stale awaiting metadata', () => {
        // Given: a stale/corrupt projection payload that escaped its parser boundary.
        const input = JSON.parse('{"status":"awaiting","awaiting":{"reason":"approval","source":{"jobId":"wrong"}}}');

        // When: the display formatter receives the malformed runtime value.
        const label = formatSessionStatusLabel(input);
        const full = formatSessionStatusWithSource(input);

        // Then: CLI display stays compact and does not render misleading source metadata.
        expect(label).toBe('awaiting');
        expect(full).toBe('awaiting');
    });
});
