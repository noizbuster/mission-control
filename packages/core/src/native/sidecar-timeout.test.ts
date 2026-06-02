import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';
import { join } from 'node:path';

const root = process.cwd();

describe('sidecar timeout fallback', () => {
    it('emits native.warning and falls back to mock when the sidecar hangs', async () => {
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: join(root, 'scripts/fixtures/hanging-sidecar.sh'),
            sidecarTimeoutMs: 50,
        });
        const events: AgentEvent[] = [];
        runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();

        const warning = events.find((event) => event.type === 'native.warning');
        expect(warning?.message).toContain('timed out');
        expect(events.at(-1)?.type).toBe('task.completed');
        expect(runtime.getSnapshot().lastMessage).toBe('completed by mock sidecar');
    });
});
