import { describe, expect, it } from 'vitest';
import {
    createOwnerFixtureAck,
    createOwnerFixtureReady,
    OWNER_FIXTURE_SESSION_IDS,
    OWNER_FIXTURE_STATE_TABLE,
    parseOwnerFixtureCommand,
} from './fixtures/session-stop-owner.js';
import { readFileSync } from 'node:fs';

describe('session stop owner fixture protocol', () => {
    it('uses only the product runtime client for canonical database writes', () => {
        const source = readFileSync(new URL('./fixtures/session-stop-owner.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('node:sqlite');
        expect(source).not.toContain('DatabaseSync');
        expect(source).toContain('runLocalLibsqlWrite');
    });

    it('locks the three cross-process session identities', () => {
        expect(OWNER_FIXTURE_SESSION_IDS).toEqual(['mc-stop-root', 'mc-stop-child', 'mc-stop-grandchild']);
    });

    it('emits the exact ready and ack NDJSON values', () => {
        expect(createOwnerFixtureReady('tree', '/tmp/mc-owner/mission-control.db')).toEqual({
            type: 'ready',
            scenario: 'tree',
            dbPath: '/tmp/mc-owner/mission-control.db',
            sessionIds: OWNER_FIXTURE_SESSION_IDS,
        });
        expect(createOwnerFixtureAck('shutdown')).toEqual({
            type: 'ack',
            command: 'shutdown',
            ok: true,
        });
    });

    it('accepts only release, spawn-child, and shutdown controls', () => {
        expect(parseOwnerFixtureCommand('{"command":"release","handleId":"provider:mc-stop-child"}')).toEqual({
            command: 'release',
            handleId: 'provider:mc-stop-child',
        });
        expect(
            parseOwnerFixtureCommand('{"command":"spawn-child","parentId":"mc-stop-root","childId":"mc-stop-child"}'),
        ).toEqual({ command: 'spawn-child', parentId: 'mc-stop-root', childId: 'mc-stop-child' });
        expect(parseOwnerFixtureCommand('{"command":"shutdown"}')).toEqual({ command: 'shutdown' });
        expect(() => parseOwnerFixtureCommand('{"command":"release"}')).toThrow('invalid owner fixture command');
        expect(() => parseOwnerFixtureCommand('{"command":"unknown"}')).toThrow('invalid owner fixture command');
    });

    it('locks every scenario state-table expectation', () => {
        expect(OWNER_FIXTURE_STATE_TABLE).toEqual({
            active: { root: 'running', child: 'idle(aborted)', grandchild: 'absent' },
            blocked: { root: 'running', child: 'idle(aborted)', grandchild: 'absent' },
            tree: { root: 'running', child: 'idle(aborted)', grandchild: 'idle(aborted)' },
            noncooperative: { root: 'running', child: 'idle(aborted)', grandchild: 'running(timeout)' },
            'owner-death': {
                root: 'running(stale-owner)',
                child: 'running(stale-owner)',
                grandchild: 'running(stale-owner)',
            },
        });
    });
});
