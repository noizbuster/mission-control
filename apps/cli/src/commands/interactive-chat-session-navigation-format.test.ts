import { projectJsonlSessionReplayPrefix } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { formatSessionSummary } from './interactive-chat-session-navigation-format';

describe('interactive session navigation formatting', () => {
    it.each([
        [
            'approval',
            {
                reason: 'approval',
                source: { approvalId: 'approval_patch', runId: 'run_1', toolCallId: 'patch_call' },
            },
            'Status: awaiting approval (approval=approval_patch,run=run_1,tool=patch_call)',
        ],
        [
            'user input',
            {
                reason: 'user_input',
                source: { runId: 'run_plan' },
            },
            'Status: awaiting user input (run=run_plan)',
        ],
        [
            'subagent',
            {
                reason: 'subagent',
                source: { jobId: 'job_child', childSessionId: 'session_child' },
            },
            'Status: awaiting subagent (job=job_child,child=session_child)',
        ],
    ] satisfies readonly (readonly [
        string,
        NonNullable<ReturnType<typeof baseReplay>['projection']['snapshot']['awaiting']>,
        string,
    ])[])('formats awaiting %s in the TUI session summary', (_name, awaiting, expectedStatusLine) => {
        // Given: a public replay snapshot carrying an awaiting lifecycle status.
        const sessionId = 'session_tui_summary';
        const replay = baseReplay(sessionId);
        const awaitingReplay = {
            ...replay,
            projection: {
                ...replay.projection,
                snapshot: {
                    ...replay.projection.snapshot,
                    status: 'awaiting' as const,
                    awaiting,
                },
            },
        };

        // When: the interactive/TUI session summary is rendered.
        const summary = formatSessionSummary(sessionId, awaitingReplay);

        // Then: compact awaiting copy and source metadata are visible.
        expect(summary.split('\n')).toContain(expectedStatusLine);
    });
});

function baseReplay(sessionId: string) {
    return projectJsonlSessionReplayPrefix({
        sessionId,
        contents: JSON.stringify({
            kind: 'mission-control.session-log',
            version: 1,
            sessionId,
            createdAt: '2026-06-05T10:00:00.000Z',
        }),
    });
}
