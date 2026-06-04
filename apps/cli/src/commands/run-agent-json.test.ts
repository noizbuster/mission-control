import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent JSON reporter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('json reporter emits valid JSON Lines', async () => {
        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });
        const lines = output.trim().split('\n');
        const parsed = lines.map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.some((event) => event.type === 'session.started')).toBe(true);
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(true);
    });

    it('json output includes selected provider and model metadata', async () => {
        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.find((event) => event.type === 'session.started')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(parsed.find((event) => event.type === 'task.completed')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('json reporter emits graph events for authored graph', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-graph-'));
        const graphPath = join(directory, 'research.graph.json');
        await writeFile(graphPath, JSON.stringify(createGraphSpec()), 'utf8');
        vi.stubEnv('INIT_CWD', directory);

        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            graphPath: 'research.graph.json',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        await rm(directory, { recursive: true, force: true });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.map((event) => event.type)).toEqual(
            expect.arrayContaining(['graph.started', 'node.completed', 'graph.completed']),
        );
        expect(parsed.find((event) => event.type === 'node.completed')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });
});

function createGraphSpec() {
    return {
        id: 'cli-research',
        entryNodeId: 'answer',
        nodes: [
            {
                id: 'answer',
                kind: 'llm',
            },
        ],
        edges: [],
        rules: [],
        policies: [],
    };
}
