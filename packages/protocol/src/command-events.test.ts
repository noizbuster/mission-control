import { describe, expect, it } from 'vitest';
import { CommandRunEventMetadataSchema } from './command-events.js';
import { AgentEventSchema } from './schema.js';

describe('command event protocol schemas', () => {
    it('parses replayable command timeout events with truncation metadata', () => {
        const metadata = CommandRunEventMetadataSchema.parse({
            command: ['pnpm', 'test'],
            cwd: '/workspace/mission-control',
            status: 'timed_out',
            exitCode: null,
            signal: 'SIGTERM',
            timedOut: true,
            stdoutTruncated: true,
            stderrTruncated: false,
            durationMs: 5000,
        });
        const event = AgentEventSchema.parse({
            type: 'command.timed_out',
            timestamp: '2026-06-09T00:00:00.000Z',
            taskId: 'tool_command',
            message: 'timed_out: pnpm test',
            nativeSidecarStatus: 'mock',
            command: metadata,
        });

        expect(event.command?.timedOut).toBe(true);
        expect(event.command?.stdoutTruncated).toBe(true);
    });
});
