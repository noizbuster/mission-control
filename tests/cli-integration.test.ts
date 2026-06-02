import { describe, expect, it } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { runAgent } from '../apps/cli/src/commands/run-agent.js';

describe('CLI integration', () => {
    it('emits the plain mode demo report', async () => {
        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('task.completed');
    });

    it('emits JSON Lines demo events', async () => {
        const output = await runAgent(parseArgs(['--json']));
        const lines = output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { readonly type?: string });

        expect(lines.some((line) => line.type === 'session.started')).toBe(true);
        expect(lines.some((line) => line.type === 'task.completed')).toBe(true);
    });
});
