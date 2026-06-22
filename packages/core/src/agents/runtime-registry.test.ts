import { describe, expect, it } from 'vitest';
import type { AgentRef } from './runtime-registry.js';
import { getRuntimeRegistry, MAIN_AGENT_ID, RuntimeAgentRegistry } from './runtime-registry.js';

type AdoptInput = Omit<AgentRef, 'createdAt' | 'lastActivity'>;

function makeAdoptInput(id: string, overrides: Partial<AdoptInput> = {}): AdoptInput {
    return {
        id,
        displayName: id,
        kind: 'sub',
        status: 'running',
        sessionId: `session-${id}`,
        ...overrides,
    };
}

describe('RuntimeAgentRegistry', () => {
    it('listVisibleTo excludes the caller and advisors but keeps main and peer subs', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('main', { kind: 'main' }));
        registry.adopt(makeAdoptInput('sub-1', { kind: 'sub' }));
        registry.adopt(makeAdoptInput('sub-2', { kind: 'sub' }));
        registry.adopt(makeAdoptInput('advisor-1', { kind: 'advisor' }));

        const visible = registry.listVisibleTo('sub-1');
        expect(visible).toHaveLength(2);
        expect(visible.map((ref) => ref.id)).toEqual(['main', 'sub-2']);
    });

    it('adopt(Main) is a no-op: no ref is created for the main session id', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput(MAIN_AGENT_ID, { kind: 'main' }));

        expect(registry.lookup(MAIN_AGENT_ID)).toBeUndefined();
    });

    it('lookup returns undefined for unknown ids', () => {
        const registry = new RuntimeAgentRegistry();

        expect(registry.lookup('does-not-exist')).toBeUndefined();
    });

    it('release removes a ref from the registry', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('sub-release'));
        expect(registry.lookup('sub-release')).toBeDefined();

        registry.release('sub-release');

        expect(registry.lookup('sub-release')).toBeUndefined();
    });

    it('release on an unknown id is a no-op', () => {
        const registry = new RuntimeAgentRegistry();

        expect(() => registry.release('ghost')).not.toThrow();
    });

    it('adopt stamps createdAt and lastActivity with matching ISO timestamps', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('sub-stamp'));

        const ref = registry.lookup('sub-stamp');
        expect(ref).toBeDefined();
        expect(ref?.createdAt).toBe(ref?.lastActivity);
        if (ref !== undefined) {
            expect(new Date(ref.createdAt).toISOString()).toBe(ref.createdAt);
        }
    });

    it('adopt preserves parentId, sessionFile, and activity from the input', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(
            makeAdoptInput('sub-full', {
                kind: 'sub',
                parentId: 'main',
                sessionFile: '/tmp/sub-full.jsonl',
                activity: 'investigating',
            }),
        );

        const ref = registry.lookup('sub-full');
        expect(ref?.parentId).toBe('main');
        expect(ref?.sessionFile).toBe('/tmp/sub-full.jsonl');
        expect(ref?.activity).toBe('investigating');
    });

    it('update merges status, lastActivity, activity, and sessionFile', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('sub-update'));

        registry.update('sub-update', {
            status: 'idle',
            lastActivity: '2026-01-01T00:00:00.000Z',
            activity: 'reviewing',
            sessionFile: '/tmp/sub-update.jsonl',
        });

        const ref = registry.lookup('sub-update');
        expect(ref?.status).toBe('idle');
        expect(ref?.lastActivity).toBe('2026-01-01T00:00:00.000Z');
        expect(ref?.activity).toBe('reviewing');
        expect(ref?.sessionFile).toBe('/tmp/sub-update.jsonl');
    });

    it('update applies partial patches without clearing unmentioned fields', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('sub-partial', { activity: 'working', sessionFile: '/tmp/a.jsonl' }));

        registry.update('sub-partial', { status: 'parked' });

        const ref = registry.lookup('sub-partial');
        expect(ref?.status).toBe('parked');
        expect(ref?.activity).toBe('working');
        expect(ref?.sessionFile).toBe('/tmp/a.jsonl');
    });

    it('update on an unknown id is a no-op', () => {
        const registry = new RuntimeAgentRegistry();

        expect(() => registry.update('ghost', { status: 'idle' })).not.toThrow();
    });

    it('clear empties the registry', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAdoptInput('sub-a'));
        registry.adopt(makeAdoptInput('sub-b'));

        registry.clear();

        expect(registry.lookup('sub-a')).toBeUndefined();
        expect(registry.lookup('sub-b')).toBeUndefined();
        expect(registry.listVisibleTo('sub-a')).toHaveLength(0);
    });

    it('getRuntimeRegistry returns the same singleton across calls', () => {
        const first = getRuntimeRegistry();
        const second = getRuntimeRegistry();

        expect(first).toBe(second);
        expect(first).toBeInstanceOf(RuntimeAgentRegistry);
    });
});
