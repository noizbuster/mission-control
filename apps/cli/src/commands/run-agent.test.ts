import { describe, expect, it } from 'vitest';
import { runAgent } from './run-agent.js';

describe('runAgent plain reporter', () => {
    it('plain reporter prints stable mission-control summary', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('session_');
        expect(output).toContain('task.completed');
        expect(output).toContain('completed by mock sidecar');
    });
});
