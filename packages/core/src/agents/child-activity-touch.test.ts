import type { AbgEmbeddedEvent, AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child';
import { SqlAgentJobMirror } from './agent-job-sql-mirror';
import {
    CHILD_ACTIVITY_TOUCH_MIN_MS,
    childActivityFromSignal,
    composeChildHostCallbacksWithActivity,
    createChildActivitySignalObserver,
} from './child-activity-touch';
import { RuntimeAgentRegistry } from './runtime-registry';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emitSignal(eventType: string, nodeId = 'n1'): AbgSignal {
    const event: AbgEmbeddedEvent = {
        id: `evt_${eventType}`,
        type: eventType,
        source: 'llm-actor',
        timestamp: '2026-07-26T00:00:00.000Z',
    };
    return { type: 'emit', nodeId, event };
}

describe('childActivityFromSignal', () => {
    it('uses the embedded event type for emit signals', () => {
        expect(childActivityFromSignal(emitSignal('tool.call'))).toBe('tool.call');
    });

    it('uses the progress message when present, else "progress"', () => {
        expect(childActivityFromSignal({ type: 'progress', nodeId: 'n', message: 'reading' })).toBe('reading');
        expect(childActivityFromSignal({ type: 'progress', nodeId: 'n' })).toBe('progress');
    });

    it('falls back to the signal type otherwise', () => {
        expect(childActivityFromSignal({ type: 'started', nodeId: 'n' })).toBe('started');
        expect(childActivityFromSignal({ type: 'transition', nodeId: 'n', from: 'a', to: 'b' })).toBe('transition');
    });
});

describe('createChildActivitySignalObserver', () => {
    it('touches the registry on the first signal after a quiet period', () => {
        const touch = vi.fn();
        const registry = { touch } as unknown as RuntimeAgentRegistry;
        const observe = createChildActivitySignalObserver('sess-x', registry);

        observe(emitSignal('run.started'));

        expect(touch).toHaveBeenCalledTimes(1);
        expect(touch).toHaveBeenCalledWith('sess-x', 'run.started');
    });

    it('throttles rapid signals to one touch per interval', () => {
        vi.useFakeTimers();
        try {
            const touch = vi.fn();
            const registry = { touch } as unknown as RuntimeAgentRegistry;
            const observe = createChildActivitySignalObserver('sess-x', registry);

            // First signal at t=0 touches.
            vi.setSystemTime(0);
            observe(emitSignal('run.started'));
            // Many rapid signals inside the throttle window are dropped.
            for (let i = 0; i < 50; i++) observe(emitSignal('tool.call'));
            expect(touch).toHaveBeenCalledTimes(1);

            // After the interval elapses, the next signal touches again.
            vi.setSystemTime(CHILD_ACTIVITY_TOUCH_MIN_MS + 1);
            observe(emitSignal('tool.result'));
            expect(touch).toHaveBeenCalledTimes(2);
            expect(touch).toHaveBeenLastCalledWith('sess-x', 'tool.result');
        } finally {
            vi.useRealTimers();
        }
    });

    it('is a silent no-op for unknown registry ids', () => {
        const registry = new RuntimeAgentRegistry();
        const observe = createChildActivitySignalObserver('not-adopted', registry);
        expect(() => observe(emitSignal('run.started'))).not.toThrow();
    });
});

describe('composeChildHostCallbacksWithActivity', () => {
    it('calls the host onSignal after touching the registry', () => {
        const touch = vi.fn();
        const registry = { touch } as unknown as RuntimeAgentRegistry;
        const hostOnSignal = vi.fn();
        const base: ChildHostCallbacks = { onSignal: hostOnSignal };

        const composed = composeChildHostCallbacksWithActivity(base, 'sess-x', registry);
        composed.onSignal?.(emitSignal('tool.call'));

        expect(touch).toHaveBeenCalledWith('sess-x', 'tool.call');
        expect(hostOnSignal).toHaveBeenCalledTimes(1);
    });

    it('creates an onSignal-only bag when the child was isolated', () => {
        const touch = vi.fn();
        const registry = { touch } as unknown as RuntimeAgentRegistry;

        const composed = composeChildHostCallbacksWithActivity(undefined, 'sess-x', registry);
        expect(composed.onSignal).toBeDefined();
        expect(composed.requestUserQuestion).toBeUndefined();

        composed.onSignal?.(emitSignal('run.started'));
        expect(touch).toHaveBeenCalledWith('sess-x', 'run.started');
    });

    it('preserves all base host callbacks besides onSignal', () => {
        const touch = vi.fn();
        const registry = { touch } as unknown as RuntimeAgentRegistry;
        const base: ChildHostCallbacks = {
            onSignal: vi.fn(),
            output: { write: vi.fn() },
            observabilityRedactor: { redactText: (t: string) => t } as never,
        };

        const composed = composeChildHostCallbacksWithActivity(base, 'sess-x', registry);
        expect(composed.output).toBe(base.output);
        expect(composed.observabilityRedactor).toBe(base.observabilityRedactor);
    });
});

describe('child activity touch integration with SQL mirror', () => {
    it('advances sessions/runtime_agents updated_at when a child signal fires', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mc-child-activity-mirror-'));
        const db = await openLocalLibsqlDb({ url: `file:${join(dir, 'probe.db')}` });
        const mirror = await SqlAgentJobMirror.create(db);
        try {
            const registry = new RuntimeAgentRegistry({ mirror });
            const childSessionId = 'sess-activity-integration';
            registry.adopt({
                id: childSessionId,
                displayName: 'activity-child',
                kind: 'sub',
                parentId: 'parent-session',
                status: 'running',
                sessionId: childSessionId,
            });
            await mirror.flush();

            const readTimestamps = async () => {
                const sessionRow = await db.client.execute({
                    sql: 'SELECT updated_at, last_activity_at FROM sessions WHERE session_id = ?',
                    args: [childSessionId],
                });
                const agentRow = await db.client.execute({
                    sql: 'SELECT updated_at FROM runtime_agents WHERE session_id = ?',
                    args: [childSessionId],
                });
                return {
                    sessionUpdatedAt: String(sessionRow.rows[0]?.['updated_at'] ?? ''),
                    sessionLastActivity: String(sessionRow.rows[0]?.['last_activity_at'] ?? ''),
                    agentUpdatedAt: String(agentRow.rows[0]?.['updated_at'] ?? ''),
                };
            };

            const before = await readTimestamps();
            expect(before.sessionUpdatedAt).not.toBe('');

            // Simulate the child graph emitting a durable signal mid-run.
            const composed = composeChildHostCallbacksWithActivity(undefined, childSessionId, registry);
            composed.onSignal?.(emitSignal('tool.call'));
            await mirror.flush();

            const after = await readTimestamps();
            // updated_at / last_activity_at advanced past the adopt timestamp.
            expect(Date.parse(after.sessionUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(before.sessionUpdatedAt));
            expect(Date.parse(after.sessionLastActivity)).toBeGreaterThanOrEqual(
                Date.parse(before.sessionLastActivity),
            );
            expect(Date.parse(after.agentUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(before.agentUpdatedAt));
        } finally {
            db.close();
        }
    });
});
