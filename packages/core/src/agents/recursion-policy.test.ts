import { describe, expect, it } from 'vitest';
import {
    canSpawnAtDepth,
    DEFAULT_MAX_RECURSION_DEPTH,
    HARD_RECURSION_CAP,
    RecursionTracker,
} from './recursion-policy.js';

describe('module constants', () => {
    it('ships the oh-my-pi default recursion depth of 2', () => {
        // Mirrors oh-my-pi's DEFAULT_MAX_RECURSION_DEPTH. A depth-2 cap means a
        // root agent (depth 0) may spawn one child (depth 1), and that child
        // may spawn one more (depth 2 is the boundary, blocked).
        expect(DEFAULT_MAX_RECURSION_DEPTH).toBe(2);
    });

    it('ships a hard recursion cap of 10 that bounds even unlimited (-1) configs', () => {
        expect(HARD_RECURSION_CAP).toBe(10);
    });
});

describe('canSpawnAtDepth — explicit max depth', () => {
    it('allows spawning when taskDepth is below maxRecursionDepth (max=2, depth=1 -> true)', () => {
        // TDD case (a): the child at depth 1 still holds the task tool under a
        // max-2 policy, so it may spawn its own child at depth 2.
        expect(canSpawnAtDepth(2, 1)).toBe(true);
    });

    it('denies spawning when taskDepth reaches maxRecursionDepth (max=2, depth=2 -> false)', () => {
        // TDD case (b): at the boundary the task tool is revoked; the agent at
        // depth 2 cannot spawn a depth-3 grandchild.
        expect(canSpawnAtDepth(2, 2)).toBe(false);
    });

    it('denies spawning for every depth when maxRecursionDepth is 0 (max=0 -> false)', () => {
        // TDD case (d): a zero budget revokes the task tool immediately, even
        // at the root (depth 0). No spawning is ever permitted.
        expect(canSpawnAtDepth(0, 0)).toBe(false);
        expect(canSpawnAtDepth(0, 1)).toBe(false);
        expect(canSpawnAtDepth(0, 99)).toBe(false);
    });

    it('respects the strict less-than boundary at other max values (max=3)', () => {
        expect(canSpawnAtDepth(3, 2)).toBe(true);
        expect(canSpawnAtDepth(3, 3)).toBe(false);
    });
});

describe('canSpawnAtDepth — unlimited (max=-1) with hard cap', () => {
    it('allows deep spawning beyond any explicit cap when unlimited (max=-1, depth=5 -> true)', () => {
        // TDD case (c): max=-1 disables the user-configured cap, so a depth
        // that would far exceed a normal max (e.g. 5 > 2) is still allowed.
        expect(canSpawnAtDepth(-1, 5)).toBe(true);
    });

    it('allows spawning just under the hard cap (max=-1, depth=9 -> true)', () => {
        // The deepest legal depth under HARD_RECURSION_CAP (10) is 9.
        expect(canSpawnAtDepth(-1, 9)).toBe(true);
    });

    it('denies spawning at the hard cap even in unlimited mode (max=-1, depth=10 -> false)', () => {
        // TDD case (e): HARD_RECURSION_CAP is an absolute ceiling. Even with
        // max=-1 (no user cap), depth 10 is blocked so recursion cannot run
        // away forever.
        expect(canSpawnAtDepth(-1, 10)).toBe(false);
    });

    it('denies spawning beyond the hard cap in unlimited mode (max=-1, depth=15 -> false)', () => {
        expect(canSpawnAtDepth(-1, 15)).toBe(false);
    });

    it('treats any negative max as unlimited, not just -1 (max=-5, depth=7 -> true)', () => {
        // Any negative value means "no user-configured cap"; only the hard cap
        // applies.
        expect(canSpawnAtDepth(-5, 7)).toBe(true);
        expect(canSpawnAtDepth(-5, 10)).toBe(false);
    });
});

describe('RecursionTracker — stateful depth bookkeeping', () => {
    it('defaults to DEFAULT_MAX_RECURSION_DEPTH when constructed with no argument', () => {
        const tracker = new RecursionTracker();
        // Default cap is 2: root (0) and first child (1) can spawn; depth 2 is blocked.
        expect(tracker.canSpawn(0)).toBe(true);
        expect(tracker.canSpawn(1)).toBe(true);
        expect(tracker.canSpawn(2)).toBe(false);
    });

    it('respects an explicit maxDepth passed to the constructor', () => {
        const tracker = new RecursionTracker(4);
        expect(tracker.canSpawn(3)).toBe(true);
        expect(tracker.canSpawn(4)).toBe(false);
    });

    it('honours unlimited (-1) while still enforcing the hard cap', () => {
        const tracker = new RecursionTracker(-1);
        expect(tracker.canSpawn(5)).toBe(true);
        expect(tracker.canSpawn(9)).toBe(true);
        expect(tracker.canSpawn(10)).toBe(false);
    });

    it('childDepth returns parentDepth + 1 so callers can thread depth through spawn chains', () => {
        const tracker = new RecursionTracker();
        expect(tracker.childDepth(0)).toBe(1);
        expect(tracker.childDepth(1)).toBe(2);
        expect(tracker.childDepth(5)).toBe(6);
    });

    it('composes canSpawn + childDepth to model a real spawn chain under the default cap', () => {
        // Root (depth 0) spawns a child -> child lives at depth 1.
        // Child (depth 1) may still spawn -> grandchild lives at depth 2.
        // Grandchild (depth 2) is at the boundary and must NOT spawn further.
        const tracker = new RecursionTracker();

        const childDepth = tracker.childDepth(0);
        expect(childDepth).toBe(1);
        expect(tracker.canSpawn(childDepth)).toBe(true);

        const grandchildDepth = tracker.childDepth(childDepth);
        expect(grandchildDepth).toBe(2);
        expect(tracker.canSpawn(grandchildDepth)).toBe(false);
    });
});
