import { describe, expect, it } from 'vitest';
import {
    SESSION_STOP_TREE_MAX_RESCANS,
    SESSION_STOP_TREE_MAX_SESSIONS,
    SESSION_STOP_TREE_MAX_TIMEOUT_MS,
    SESSION_STOP_TREE_RETRY_DELAY_MS,
    stopSessionTree,
} from './session-stop-tree';
import { SESSION_STOP_TREE_SHARED_FIXTURES } from './session-stop-tree-fixtures';
import { resolveCanonicalSessionTree } from './session-stop-tree-resolver';
import { createSessionStopTreeHarness as createHarness } from './session-stop-tree-test-support';

describe('canonical session stop tree', () => {
    it('shares stable parent fixtures and ignores root metadata and provenance relations', () => {
        for (const fixture of SESSION_STOP_TREE_SHARED_FIXTURES) {
            const result = resolveCanonicalSessionTree(fixture);
            if (fixture.expectedErrorCode !== undefined) {
                expect(result).toEqual({ ok: false, errorCode: fixture.expectedErrorCode });
                continue;
            }
            if (!result.ok) throw new Error('expected stable fixture');
            expect(Object.fromEntries(result.nodes.map((node) => [node.sessionId, node.parentSessionId]))).toEqual(
                fixture.expectedParents,
            );
        }
    });

    it.each([
        {
            name: 'missing explicit parent',
            targetSessionId: 'orphan',
            sessions: [{ sessionId: 'orphan', parentSessionId: 'missing' }],
            relations: [{ parentSessionId: 'root', childSessionId: 'orphan', kind: 'subagent' }],
        },
        {
            name: 'self explicit parent',
            targetSessionId: 'self',
            sessions: [{ sessionId: 'self', parentSessionId: 'self' }],
            relations: [],
        },
        {
            name: 'self relation parent',
            targetSessionId: 'self',
            sessions: [{ sessionId: 'self', parentSessionId: null }],
            relations: [{ parentSessionId: 'self', childSessionId: 'self', kind: 'parent_child' }],
        },
    ])('fails $name without recovering through another edge', (fixture) => {
        expect(resolveCanonicalSessionTree(fixture)).toEqual({ ok: false, errorCode: 'unstable_session_tree' });
    });

    it('does not let an unrelated unstable component poison the selected component', () => {
        const result = resolveCanonicalSessionTree({
            targetSessionId: 'root',
            sessions: [
                { sessionId: 'root', parentSessionId: null },
                { sessionId: 'child', parentSessionId: 'root' },
                { sessionId: 'unrelated', parentSessionId: 'missing' },
            ],
            relations: [],
        });
        expect(result).toMatchObject({ ok: true, descendants: [{ sessionId: 'child', depth: 1 }] });
    });

    it('deduplicates equal session rows and fails closed above the component bound', () => {
        expect(
            resolveCanonicalSessionTree({
                targetSessionId: 'root',
                sessions: [
                    { sessionId: 'root', parentSessionId: null },
                    { sessionId: 'root', parentSessionId: null },
                ],
                relations: [],
            }),
        ).toMatchObject({ ok: true, nodes: [{ sessionId: 'root', parentSessionId: null }] });
        const sessions = Array.from({ length: SESSION_STOP_TREE_MAX_SESSIONS + 1 }, (_, index) => ({
            sessionId: `bounded-${index}`,
            parentSessionId: index === 0 ? null : `bounded-${index - 1}`,
        }));
        expect(resolveCanonicalSessionTree({ targetSessionId: 'bounded-0', sessions, relations: [] })).toEqual({
            ok: false,
            errorCode: 'unstable_session_tree',
        });
    });
});

describe('fixed-point session stop orchestration', () => {
    it('exports the approved bounds and stops children leaf-first with sibling parallelism', async () => {
        expect({
            sessions: SESSION_STOP_TREE_MAX_SESSIONS,
            rescans: SESSION_STOP_TREE_MAX_RESCANS,
            timeout: SESSION_STOP_TREE_MAX_TIMEOUT_MS,
            retry: SESSION_STOP_TREE_RETRY_DELAY_MS,
        }).toEqual({ sessions: 4_096, rescans: 64, timeout: 300_000, retry: 25 });
        const harness = createHarness({ root: null, a: 'root', b: 'root', leaf: 'a' });
        const result = await stopSessionTree(harness.input('children'));

        expect(result.outcome).toBe('full');
        expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(['leaf', 'a', 'b']);
        expect(harness.acquisitions).toEqual([
            { sessionId: 'root', barrierKind: 'child_spawn_only' },
            { sessionId: 'a', barrierKind: 'all_mutations' },
            { sessionId: 'b', barrierKind: 'all_mutations' },
            { sessionId: 'leaf', barrierKind: 'all_mutations' },
        ]);
        expect(harness.events).toEqual([
            'acquire:root',
            'acquire:a',
            'acquire:b',
            'acquire:leaf',
            'stop:leaf',
            'stop:a',
            'stop:b',
            'release:leaf',
            'release:b',
            'release:a',
            'release:root',
        ]);
    });

    it('implements only and tree scopes without duplicate targets', async () => {
        const onlyHarness = createHarness({ root: null, child: 'root' });
        const only = await stopSessionTree(onlyHarness.input('only'));
        expect(only.sessions.map(({ sessionId }) => sessionId)).toEqual(['root']);
        expect(onlyHarness.events.filter((event) => event.startsWith('stop:'))).toEqual(['stop:root']);

        const treeHarness = createHarness({ root: null, child: 'root', leaf: 'child' });
        const tree = await stopSessionTree(treeHarness.input('tree'));
        expect(tree.sessions.map(({ sessionId }) => sessionId)).toEqual(['leaf', 'child', 'root']);
    });

    it('traverses terminal targets and descendants without requiring their owners', async () => {
        const harness = createHarness(
            { root: null, terminal: 'root', leaf: 'terminal' },
            new Set(['root', 'terminal']),
        );
        const input = harness.input('tree');
        const readTree = async () =>
            resolveCanonicalSessionTree({
                targetSessionId: 'root',
                sessions: [
                    { sessionId: 'root', parentSessionId: null, status: 'stopped' },
                    { sessionId: 'terminal', parentSessionId: 'root', status: 'failed' },
                    { sessionId: 'leaf', parentSessionId: 'terminal', status: 'running' },
                ],
                relations: [],
            });
        const result = await stopSessionTree({ ...input, readTree });
        expect(result.sessions.map(({ sessionId, outcome }) => [sessionId, outcome])).toEqual([
            ['leaf', 'interrupted'],
            ['terminal', 'already_terminal'],
            ['root', 'already_terminal'],
        ]);
        expect(harness.events.filter((event) => event.startsWith('acquire:'))).toEqual(['acquire:leaf']);
    });

    it('rescans to a stable fixed point and fences a child that appears during acquisition', async () => {
        const harness = createHarness({ root: null, child: 'root' });
        let scans = 0;
        harness.snapshots = () => {
            scans += 1;
            return scans < 3 ? { root: null, child: 'root' } : { root: null, child: 'root', late: 'child' };
        };
        const result = await stopSessionTree(harness.input('children'));
        expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(['late', 'child']);
        expect(harness.events).toContain('acquire:late');
    });

    it('has zero descendant effects when the target barrier fails', async () => {
        const harness = createHarness({ root: null, child: 'root' }, new Set(['root']));
        const result = await stopSessionTree(harness.input('children'));
        expect(result).toMatchObject({ outcome: 'failed', errorCode: 'owner_unreachable', sessions: [] });
        expect(harness.events).toEqual(['acquire:root']);
    });

    it('requires a stable empty rescan and never fences below an unfenced branch', async () => {
        const empty = createHarness({ root: null });
        let scans = 0;
        empty.snapshots = () => {
            scans += 1;
            return { root: null };
        };
        expect(await stopSessionTree(empty.input('children'))).toMatchObject({ outcome: 'no_op', sessions: [] });
        expect(scans).toBe(3);

        const branch = createHarness({ root: null, parent: 'root', leaf: 'parent' }, new Set(['parent']));
        const result = await stopSessionTree(branch.input('children'));
        expect(result.outcome).toBe('failed');
        expect(new Set(result.sessions.map(({ operationId }) => operationId)).size).toBe(result.sessions.length);
        expect(branch.events).not.toContain('acquire:leaf');
        expect(branch.events.filter((event) => event.startsWith('stop:'))).toEqual([]);
    });

    it('advances the fake monotonic clock at the exact retry cadence and honors the overall deadline', async () => {
        const harness = createHarness({ root: null });
        let scans = 0;
        let now = 0;
        const delays: number[] = [];
        harness.snapshots = () => {
            scans += 1;
            return Object.fromEntries([
                ['root', null],
                ...Array.from({ length: scans }, (_, index) => [`late-${index}`, 'root']),
            ]);
        };
        const result = await stopSessionTree({
            ...harness.input('children'),
            timeoutMs: 50,
            monotonicNow: () => now,
            sleep: async (delayMs) => {
                delays.push(delayMs);
                now += delayMs;
            },
        });
        expect(result).toMatchObject({ outcome: 'failed', errorCode: 'stop_timeout', sessions: [] });
        expect(delays).toEqual([25, 25]);
        expect(harness.events.some((event) => event.startsWith('stop:'))).toBe(false);
    });

    it('fails zero-effect when an observed parent changes after barriers are acquired', async () => {
        const harness = createHarness({ root: null, child: 'root' });
        let scans = 0;
        harness.snapshots = () => {
            scans += 1;
            return scans < 3 ? { root: null, child: 'root' } : { root: null, child: null };
        };
        const result = await stopSessionTree(harness.input('children'));
        expect(result).toMatchObject({ outcome: 'failed', errorCode: 'unstable_session_tree', sessions: [] });
        expect(harness.events.some((event) => event.startsWith('stop:'))).toBe(false);
    });

    it('continues a fenced sibling after one leaf times out and releases every barrier', async () => {
        const harness = createHarness({ root: null, bad: 'root', good: 'root' });
        harness.failedStops.add('bad');
        const result = await stopSessionTree(harness.input('children'));
        expect(result.outcome).toBe('partial');
        expect(result.sessions).toEqual([
            expect.objectContaining({ sessionId: 'bad', outcome: 'failed', errorCode: 'stop_timeout' }),
            expect.objectContaining({ sessionId: 'good', outcome: 'interrupted' }),
        ]);
        expect(harness.events.filter((event) => event.startsWith('release:')).sort()).toEqual([
            'release:bad',
            'release:good',
            'release:root',
        ]);
    });
});
