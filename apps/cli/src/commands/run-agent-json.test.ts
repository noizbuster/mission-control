import { AgentEventSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { runAgent } from './run-agent.js';

describe('runAgent JSON reporter', () => {
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
});
