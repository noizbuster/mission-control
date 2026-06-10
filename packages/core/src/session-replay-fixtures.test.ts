import { describe, expect, it } from 'vitest';
import { projectJsonlSessionReplayPrefix } from './session-replay.js';
import { readFile } from 'node:fs/promises';

describe('session replay JSONL fixtures', () => {
    it('projects fixture JSONL logs and preserves the valid prefix before a corrupt trailing record', async () => {
        // Given
        const linear = await readFixture('linear-chat.jsonl');
        const branched = await readFixture('branched-chat.jsonl');
        const approvalBlocked = await readFixture('approval-blocked-graph.jsonl');

        // When
        const linearReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_fixture_linear',
            contents: `${linear}{"broken":\n`,
        });
        const branchedReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_fixture_branched',
            contents: branched,
        });
        const approvalReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_fixture_approval',
            contents: approvalBlocked,
        });

        // Then
        expect(linearReplay.diagnostics).toEqual([
            {
                code: 'corrupt_trailing_record',
                lineNumber: 4,
                sessionId: 'session_fixture_linear',
            },
        ]);
        expect(linearReplay.projection.snapshot.completedTaskCount).toBe(1);
        expect(branchedReplay.projection.branchTree.activeLeafId).toBe('fixture_branch_b');
        expect(approvalReplay.projection.graphSnapshots).toMatchObject([
            {
                graphId: 'graph_fixture_approval',
                status: 'blocked',
            },
        ]);
        expect(approvalReplay.projection.approvals).toMatchObject([
            {
                approvalId: 'approval_fixture_patch',
                state: 'pending',
            },
        ]);
    });
});

async function readFixture(name: string): Promise<string> {
    return readFile(new URL(`./session-replay-fixtures/${name}`, import.meta.url), 'utf8');
}
