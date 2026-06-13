import { missionControlDataDirEnvKey, projectJsonlSessionReplayPrefix } from '@mission-control/core';
import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent JSONL session automation', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('emits JSONL prompt events and persists deterministic replay records for an explicit session', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_jsonl_prompt';

        const output = await runAgent(
            parseArgs(['run', 'summarize this repository', '--session', sessionId, '--jsonl']),
        );
        const events = parseEventLines(output);
        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'),
        }).projection;

        expect(events.every((event) => event.sessionId === sessionId)).toBe(true);
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['session.started', 'task.started', 'task.completed', 'session.stopped']),
        );
        expect(events.find((event) => event.type === 'task.started')?.message).toBe(
            'user prompt: summarize this repository',
        );
        const records = parseJsonRecords(output);
        expect(lastRecord(records)).toMatchObject({
            type: 'session.stopped',
            sessionId,
            status: 'completed',
            runId: expect.any(String),
        });
        expect(replay.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(events.map((event) => event.type)),
        );
        expect(replay.snapshot.sessionId).toBe(sessionId);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('runs authored graphs through JSONL with explicit session replay snapshots', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_jsonl_graph';

        const output = await runAgent(
            parseArgs([
                'graph',
                'run',
                'examples/abg/research-answer.graph.json',
                '--session',
                sessionId,
                '--jsonl',
                '--model',
                'local/local-echo',
            ]),
        );
        const events = parseEventLines(output);
        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'),
        }).projection;

        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['graph.started', 'graph.completed']));
        expect(
            events.find((event) => event.type === 'node.started' && event.abg?.nodeId === 'draft-answer')?.abg,
        ).toMatchObject({
            nodeKind: 'llm',
        });
        expect(replay.graphSnapshots).toEqual(
            expect.arrayContaining([expect.objectContaining({ graphId: 'research-answer', status: 'completed' })]),
        );
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-jsonl-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function parseEventLines(output: string) {
    return output
        .trim()
        .split('\n')
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function parseJsonRecords(output: string): readonly Record<string, unknown>[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastRecord(records: readonly Record<string, unknown>[]): Record<string, unknown> {
    const record = records.at(-1);
    if (record === undefined) {
        throw new Error('expected at least one JSON record');
    }
    return record;
}
