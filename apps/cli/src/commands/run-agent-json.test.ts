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
});
