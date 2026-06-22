import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDisposer, AgentReviver } from './lifecycle-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import type { AgentRef, AgentRefInput } from './runtime-registry.js';
import { MAIN_AGENT_ID, RuntimeAgentRegistry } from './runtime-registry.js';

function makeRefInput(id: string, overrides: Partial<AgentRefInput> = {}): AgentRefInput {
    return {
        id,
        displayName: id,
        kind: 'sub',
        status: 'idle',
        sessionId: `session-${id}`,
        ...overrides,
    };
}

function registerIdleSub(
    registry: RuntimeAgentRegistry,
    id: string,
    sessionFile: string | null = `/tmp/${id}.jsonl`,
): void {
    registry.adopt({
        id,
        displayName: id,
        kind: 'sub',
        status: 'idle',
        sessionId: `session-${id}`,
        ...(sessionFile !== null ? { sessionFile } : {}),
    });
}

/** Build a fully-formed AgentRef for use as a revive return value. */
function refOf(id: string, status: AgentRef['status']): AgentRef {
    return {
        id,
        displayName: id,
        kind: 'sub',
        status,
        sessionId: `session-${id}`,
        sessionFile: `/tmp/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:00:00.000Z',
    };
}

interface DisposeStub {
    dispose: AgentDisposer;
    disposeCalls: () => number;
}

function makeDisposeStub(hook?: () => Promise<void>): DisposeStub {
    let calls = 0;
    const dispose: AgentDisposer = async () => {
        calls++;
        await hook?.();
    };
    return { dispose, disposeCalls: () => calls };
}

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
}

function deferred(): Deferred {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
        resolve = () => r();
    });
    return { promise, resolve };
}

/** Settle the async park chain (timer callback -> park() -> dispose -> update). */
async function flushAsync(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

const TTL = 20;

describe('AgentLifecycleManager', () => {
    let registry: RuntimeAgentRegistry;
    let lifecycle: AgentLifecycleManager;

    beforeEach(() => {
        registry = new RuntimeAgentRegistry();
        lifecycle = new AgentLifecycleManager(registry);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('adopt arms the TTL: an idle agent is parked — resources disposed, ref + sessionFile retained', async () => {
        vi.useFakeTimers();
        const stub = makeDisposeStub();
        registerIdleSub(registry, '1-Sub', '/tmp/1-Sub.jsonl');
        lifecycle.adopt('1-Sub', { idleTtlMs: TTL, dispose: stub.dispose });

        vi.advanceTimersByTime(TTL);
        await flushAsync();

        const ref = registry.lookup('1-Sub');
        expect(stub.disposeCalls()).toBe(1);
        expect(ref?.status).toBe('parked');
        expect(ref?.sessionFile).toBe('/tmp/1-Sub.jsonl');
        expect(lifecycle.has('1-Sub')).toBe(true);
    });

    it('running disarms the timer; returning to idle re-arms a fresh TTL', async () => {
        vi.useFakeTimers();
        const stub = makeDisposeStub();
        registerIdleSub(registry, '2-Sub');
        lifecycle.adopt('2-Sub', { idleTtlMs: TTL, dispose: stub.dispose });
        lifecycle.setStatus('2-Sub', 'running');

        vi.advanceTimersByTime(TTL * 10);
        await flushAsync();
        expect(registry.lookup('2-Sub')?.status).toBe('running');
        expect(stub.disposeCalls()).toBe(0);

        lifecycle.setStatus('2-Sub', 'idle');
        vi.advanceTimersByTime(TTL);
        await flushAsync();
        expect(registry.lookup('2-Sub')?.status).toBe('parked');
        expect(stub.disposeCalls()).toBe(1);
    });

    it('ensureLive revives a parked agent through its reviver and flips it back to idle', async () => {
        registry.adopt(
            makeRefInput('3-Sub', {
                status: 'parked',
                sessionFile: '/tmp/3-Sub.jsonl',
            }),
        );

        const revivedRef = refOf('3-Sub', 'idle');
        const revive: AgentReviver = async () => revivedRef;
        lifecycle.adopt('3-Sub', { idleTtlMs: 0, revive });

        const result = await lifecycle.ensureLive('3-Sub');

        expect(result).toBe(revivedRef);
        const ref = registry.lookup('3-Sub');
        expect(ref?.status).toBe('idle');
        expect(ref?.sessionFile).toBe('/tmp/3-Sub.jsonl');
    });

    it('concurrent ensureLive calls during a slow revive coalesce into one reviver run', async () => {
        const gate = deferred();
        let reviverRuns = 0;

        registry.adopt(
            makeRefInput('4-Sub', {
                status: 'parked',
                sessionFile: '/tmp/4-Sub.jsonl',
            }),
        );

        const revivedRef = refOf('4-Sub', 'idle');
        lifecycle.adopt('4-Sub', {
            idleTtlMs: 0,
            revive: async () => {
                reviverRuns++;
                await gate.promise;
                return revivedRef;
            },
        });

        const first = lifecycle.ensureLive('4-Sub');
        const second = lifecycle.ensureLive('4-Sub');
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);

        expect(reviverRuns).toBe(1);
        expect(a).toBe(revivedRef);
        expect(b).toBe(revivedRef);
    });

    it('ensureLive on an unknown id throws and points at history://', async () => {
        await expect(lifecycle.ensureLive('9-Ghost')).rejects.toThrow(/history:\/\/9-Ghost/);
    });

    it('ensureLive on a parked agent without a reviver throws as not revivable', async () => {
        // No sessionFile and no reviver: the persisted-reviver path is also unavailable.
        registry.adopt(
            makeRefInput('5-Sub', {
                status: 'parked',
            }),
        );
        lifecycle.adopt('5-Sub', { idleTtlMs: 0 });

        await expect(lifecycle.ensureLive('5-Sub')).rejects.toThrow(/cannot be revived.*no reviver registered/);
    });

    it('ensureLive cold-revives a parked ref via the persisted factory and rejoins the lifecycle', async () => {
        vi.useFakeTimers();

        registry.adopt(
            makeRefInput('6-Sub', {
                status: 'parked',
                sessionFile: '/tmp/6-Sub.jsonl',
            }),
        );

        const revivedRef = refOf('6-Sub', 'idle');
        let factoryCalls = 0;
        lifecycle.setPersistedSubagentReviverFactory(async () => {
            factoryCalls++;
            return async () => revivedRef;
        }, TTL);

        // Note: lifecycle.adopt is NOT called — the ref is registered but not
        // adopted by the lifecycle manager. Cold-revive builds the adoption
        // on demand.

        const session = await lifecycle.ensureLive('6-Sub');

        expect(factoryCalls).toBe(1);
        expect(session).toBe(revivedRef);
        expect(registry.lookup('6-Sub')?.status).toBe('idle');

        // Adopted on demand with the configured TTL: it re-parks like any idle subagent.
        vi.advanceTimersByTime(TTL);
        await flushAsync();
        expect(registry.lookup('6-Sub')?.status).toBe('parked');
    });

    it('a persisted factory that declines leaves the parked ref transcript-only', async () => {
        registry.adopt(
            makeRefInput('7-Sub', {
                status: 'parked',
                sessionFile: '/tmp/7-Sub.jsonl',
            }),
        );
        lifecycle.setPersistedSubagentReviverFactory(async () => undefined, TTL);

        await expect(lifecycle.ensureLive('7-Sub')).rejects.toThrow(/cannot be revived.*no reviver registered/);
    });

    it('a failed cold revive is not sticky: the next ensureLive re-runs the factory', async () => {
        registry.adopt(
            makeRefInput('8-Sub', {
                status: 'parked',
                sessionFile: '/tmp/8-Sub.jsonl',
            }),
        );

        const revivedRef = refOf('8-Sub', 'idle');
        let factoryCalls = 0;
        lifecycle.setPersistedSubagentReviverFactory(async () => {
            factoryCalls++;
            const failFirst = factoryCalls === 1;
            return async () => {
                if (failFirst) throw new Error('stale context');
                return revivedRef;
            };
        }, TTL);

        await expect(lifecycle.ensureLive('8-Sub')).rejects.toThrow(/stale context/);
        expect(registry.lookup('8-Sub')?.status).toBe('parked');

        const session = await lifecycle.ensureLive('8-Sub');
        expect(factoryCalls).toBe(2);
        expect(session).toBe(revivedRef);
        expect(registry.lookup('8-Sub')?.status).toBe('idle');
    });

    it('release disposes a live adopted agent, unregisters it, and leaves no pending park', async () => {
        vi.useFakeTimers();
        const stub = makeDisposeStub();
        registerIdleSub(registry, '6-Sub');
        lifecycle.adopt('6-Sub', { idleTtlMs: TTL, dispose: stub.dispose });

        await lifecycle.release('6-Sub');

        expect(stub.disposeCalls()).toBe(1);
        expect(registry.lookup('6-Sub')).toBeUndefined();
        expect(lifecycle.has('6-Sub')).toBe(false);

        // The disarmed timer must not fire a late park (which would double-dispose).
        vi.advanceTimersByTime(TTL * 10);
        await flushAsync();
        expect(stub.disposeCalls()).toBe(1);
        expect(registry.lookup('6-Sub')).toBeUndefined();
    });

    it('adopt(Main) is a no-op: Main is never adopted or parked', async () => {
        vi.useFakeTimers();
        const stub = makeDisposeStub();
        // RuntimeAgentRegistry itself no-ops for Main, so it is never
        // registered. The lifecycle manager must also no-op — no timer,
        // no dispose — even if adopt is called explicitly.
        lifecycle.adopt(MAIN_AGENT_ID, { idleTtlMs: TTL, dispose: stub.dispose });

        expect(lifecycle.has(MAIN_AGENT_ID)).toBe(false);
        vi.advanceTimersByTime(TTL * 10);
        await flushAsync();
        expect(stub.disposeCalls()).toBe(0);
    });

    it('isParking is true exactly while park dispose is in flight; parked only after it completes', async () => {
        const gate = deferred();
        const stub = makeDisposeStub(() => gate.promise);
        registerIdleSub(registry, '7-Sub');
        lifecycle.adopt('7-Sub', { idleTtlMs: 0, dispose: stub.dispose });

        // park() runs synchronously up to `await dispose(id)`, which we hold open.
        const parking = lifecycle.park('7-Sub');

        expect(stub.disposeCalls()).toBe(1);
        expect(lifecycle.isParking('7-Sub')).toBe(true);
        expect(registry.lookup('7-Sub')).toBeDefined();
        expect(registry.lookup('7-Sub')?.status).toBe('idle');

        gate.resolve();
        await parking;

        expect(lifecycle.isParking('7-Sub')).toBe(false);
        expect(registry.lookup('7-Sub')?.status).toBe('parked');
    });

    it('idleTtlMs <= 0 adopts without a timer: the agent never parks', async () => {
        vi.useFakeTimers();
        const stub = makeDisposeStub();
        registerIdleSub(registry, '8-Sub');
        lifecycle.adopt('8-Sub', { idleTtlMs: 0, dispose: stub.dispose });

        vi.advanceTimersByTime(60_000);
        await flushAsync();
        const ref = registry.lookup('8-Sub');
        expect(ref?.status).toBe('idle');
        expect(stub.disposeCalls()).toBe(0);
        expect(lifecycle.has('8-Sub')).toBe(true);
    });
});
