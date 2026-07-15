import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openMissionControlDb } from '../packages/core/src/db/mission-control-db.js';
import { AgentEventEnvelopeSchema } from '../packages/protocol/src/index.js';
import {
    type CustomWorkflowFixture,
    createCustomWorkflowFixture,
    runWorkflow,
    workflowArgs,
} from './cli-custom-workflow-tool-call-id-support.js';
import {
    type ProcessResult,
    resolveBuiltCliEntryPath,
    startBuiltCli,
    terminateTask12Processes,
} from './cli-local-db-concurrency-support.js';
import { rm } from 'node:fs/promises';

const forbiddenSuccessStderr = /SQLITE_BUSY|database is locked|client closed|UNIQUE constraint failed/iu;
const roots: string[] = [];

beforeAll(() => {
    resolveBuiltCliEntryPath();
});

afterEach(async () => {
    await terminateTask12Processes();
});

afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built CLI custom workflow tool-call identity', () => {
    it('runs the discovered workflow twice in distinct sessions against one SQL store', async () => {
        // Given
        const fixture = await createFixture('repeated');
        const sessionIds = ['custom-workflow-first', 'custom-workflow-second'] as const;

        // When
        const first = await runWorkflow(sessionIds[0], fixture);
        const second = await runWorkflow(sessionIds[1], fixture);

        // Then
        assertSuccessfulProcess(first);
        assertSuccessfulProcess(second);
        const runtime = await openMissionControlDb({ dataDir: fixture.dataDir });
        try {
            const tools = await runtime.client.execute({
                sql: `
                    SELECT tool_call_id, session_id, status, result_json
                    FROM tool_calls
                    WHERE session_id IN (?, ?)
                    ORDER BY session_id
                `,
                args: [...sessionIds],
            });
            expect(tools.rows).toHaveLength(2);
            const toolCallIds = tools.rows.map((row) => String(row.tool_call_id));
            expect(new Set(toolCallIds).size).toBe(2);
            expect(toolCallIds).not.toContain('research');
            expect(tools.rows.map((row) => row.status)).toEqual(['completed', 'completed']);

            const persistedEvents = await runtime.client.execute({
                sql: `
                    SELECT payload_json
                    FROM session_events
                    WHERE session_id IN (?, ?) AND type IN ('tool.started', 'tool.completed')
                    ORDER BY session_id, seq
                `,
                args: [...sessionIds],
            });
            const envelopes = persistedEvents.rows.map((row) =>
                AgentEventEnvelopeSchema.parse(JSON.parse(String(row.payload_json))),
            );
            for (const [index, sessionId] of sessionIds.entries()) {
                const lifecycle = envelopes
                    .filter((envelope) => envelope.sessionId === sessionId && envelope.event.abg?.nodeId === 'research')
                    .map((envelope) => envelope.event);
                expect(lifecycle.map((event) => event.type)).toEqual([
                    'tool.started',
                    'tool.started',
                    'tool.completed',
                    'tool.completed',
                ]);
                expect(lifecycle.map((event) => event.taskId)).toEqual(Array(4).fill(toolCallIds[index]));
                expect(lifecycle.flatMap((event) => event.toolResult?.toolCallId ?? [])).toEqual([toolCallIds[index]]);
                expect(String(tools.rows[index]?.result_json)).toContain(`"toolCallId":"${toolCallIds[index]}"`);
            }
        } finally {
            runtime.close();
        }
    }, 45_000);

    it('runs the discovered workflow concurrently in distinct sessions against one SQL store', async () => {
        // Given
        const fixture = await createFixture('concurrent');
        const sessionIds = ['custom-workflow-concurrent-a', 'custom-workflow-concurrent-b'] as const;

        // When
        const processes = sessionIds.map((sessionId) =>
            startBuiltCli(workflowArgs(sessionId), fixture.env).waitForExit(),
        );
        const results = await Promise.all(processes);

        // Then
        for (const result of results) assertSuccessfulProcess(result);
        const runtime = await openMissionControlDb({ dataDir: fixture.dataDir });
        try {
            const tools = await runtime.client.execute({
                sql: `
                    SELECT tool_call_id, session_id
                    FROM tool_calls
                    WHERE session_id IN (?, ?)
                    ORDER BY session_id
                `,
                args: [...sessionIds],
            });
            expect(tools.rows).toHaveLength(2);
            expect(new Set(tools.rows.map((row) => String(row.tool_call_id))).size).toBe(2);
            expect(tools.rows.map((row) => row.session_id)).toEqual([...sessionIds]);
        } finally {
            runtime.close();
        }
    }, 45_000);

    it('keeps failed tool-node lifecycle events unique across distinct sessions', async () => {
        // Given
        const fixture = await createFixture('failed');
        const sessionIds = ['failed-tool-first', 'failed-tool-second'] as const;

        // When
        const results = [];
        for (const sessionId of sessionIds) results.push(await runWorkflow(sessionId, fixture, 'failing-tool'));

        // Then
        for (const result of results) {
            expect(result).toMatchObject({ code: 0, signal: null });
            expect(result.stderr).not.toMatch(/UNIQUE constraint failed/iu);
        }
        const runtime = await openMissionControlDb({ dataDir: fixture.dataDir });
        try {
            const tools = await runtime.client.execute({
                sql: `
                    SELECT tool_call_id, session_id, status
                    FROM tool_calls
                    WHERE session_id IN (?, ?)
                    ORDER BY session_id
                `,
                args: [...sessionIds],
            });
            expect(tools.rows).toHaveLength(4);
            const toolCallIds = tools.rows.map((row) => String(row.tool_call_id));
            expect(new Set(toolCallIds).size).toBe(4);
            expect(toolCallIds).not.toContain('failing-tool-node');
            expect(tools.rows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed', 'failed']);

            const persistedEvents = await runtime.client.execute({
                sql: `
                    SELECT payload_json
                    FROM session_events
                    WHERE session_id IN (?, ?) AND type = 'tool.failed'
                    ORDER BY session_id, seq
                `,
                args: [...sessionIds],
            });
            const envelopes = persistedEvents.rows.map((row) =>
                AgentEventEnvelopeSchema.parse(JSON.parse(String(row.payload_json))),
            );
            for (const sessionId of sessionIds) {
                const sessionToolCallIds = tools.rows
                    .filter((row) => row.session_id === sessionId)
                    .map((row) => String(row.tool_call_id));
                const failures = envelopes
                    .filter(
                        (envelope) =>
                            envelope.sessionId === sessionId && envelope.event.abg?.nodeId === 'failing-tool-node',
                    )
                    .map((envelope) => envelope.event);
                expect(sessionToolCallIds).toHaveLength(2);
                expect(failures).toHaveLength(4);
                expect(new Set(failures.map((event) => event.taskId))).toEqual(new Set(sessionToolCallIds));
                for (const toolCallId of sessionToolCallIds) {
                    expect(failures.filter((event) => event.taskId === toolCallId)).toHaveLength(2);
                }
            }
        } finally {
            runtime.close();
        }
    }, 45_000);
});

async function createFixture(name: string): Promise<CustomWorkflowFixture> {
    const fixture = await createCustomWorkflowFixture(name);
    roots.push(fixture.root);
    return fixture;
}

function assertSuccessfulProcess(result: ProcessResult): void {
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toMatch(forbiddenSuccessStderr);
}
