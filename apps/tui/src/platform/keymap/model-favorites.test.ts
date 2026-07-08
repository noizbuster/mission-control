/**
 * T11 acceptance tests: model favorites store + F2 recent-model-cycle (frecency)
 * + leader+1..9 quick-switch keymap layer.
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS, no
 * native FFI) through `host.press(...)`, the faithful equivalent of a renderer
 * keypress. The F2 / Shift+F2 chords need no leader; the leader+1..9 quick
 * switches require the leader token (T7 `registerLeaderAddons`, pure JS addon).
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert F2 ACTUALLY selects the next
 *    recently-used model (exact ModelProviderSelection, not just "a call
 *    happened"); leader+1 jumps to the EXACT slot-1 favorite.
 *  - stale_state: an empty favorite slot is a no-op (no selectModel call) and
 *    emits a notice; an empty frecency with no model list is a no-op.
 *  - flaky_tests: the leader timeout is a real `setTimeout`; fake timers make
 *    the leader chord deterministic.
 *
 * F2 cycle semantics (see model-favorites.ts): walking forward/backward moves
 * an internal cursor WITHOUT reordering the frecency. Reordering happens only on
 * an explicit `record` (favorites jump, or a future Ctrl+P///model hook). This
 * avoids the IDE-style 2-cycle toggle that record-on-each-step would create.
 */
import type { ModelProviderSelection } from '@mission-control/protocol';
import { createTestKeymap } from '@opentui/keymap/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';
import {
    ModelFavorites,
    ModelFrecency,
    type ModelShortcutsDeps,
    registerModelShortcutsLayer,
    seedOrdering,
    selectionKey,
} from './model-favorites.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sel(providerID: string, modelID: string, variantID?: string): ModelProviderSelection {
    return { providerID, modelID, ...(variantID !== undefined ? { variantID } : {}) };
}

describe('selectionKey', () => {
    it('joins provider/model/variant with a stable separator', () => {
        expect(selectionKey(sel('p', 'm'))).toBe('p/m');
        expect(selectionKey(sel('p', 'm', 'v'))).toBe('p/m#v');
    });

    it('distinguishes variants from the same provider/model', () => {
        expect(selectionKey(sel('p', 'm'))).not.toBe(selectionKey(sel('p', 'm', 'v')));
    });
});

describe('seedOrdering', () => {
    it('moves the current selection to the front, preserving the rest', () => {
        const ordered = seedOrdering([sel('p', 'x'), sel('p', 'y'), sel('p', 'z')], sel('p', 'y'));
        expect(ordered.map(selectionKey)).toEqual(['p/y', 'p/x', 'p/z']);
    });

    it('returns choices unchanged when current is undefined', () => {
        const choices = [sel('p', 'x'), sel('p', 'y')];
        expect(seedOrdering(choices, undefined)).toBe(choices);
    });

    it('returns choices unchanged when current is not in the list', () => {
        const ordered = seedOrdering([sel('p', 'x'), sel('p', 'y')], sel('p', 'absent'));
        expect(ordered.map(selectionKey)).toEqual(['p/x', 'p/y']);
    });
});

// ---------------------------------------------------------------------------
// ModelFrecency
// ---------------------------------------------------------------------------

describe('ModelFrecency', () => {
    it('record prepends (most-recent first) and dedupes by provider/model/variant', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'a'));
        f.record(sel('p', 'b'));
        f.record(sel('p', 'a')); // re-record a -> moves to front, no duplicate

        expect(f.ordered().map(selectionKey)).toEqual(['p/a', 'p/b']);
    });

    it('record treats same provider/model with different variant as distinct', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'm', 'v1'));
        f.record(sel('p', 'm', 'v2'));

        expect(f.ordered().map(selectionKey)).toEqual(['p/m#v2', 'p/m#v1']);
    });

    it('next walks forward through the list WITHOUT reordering (no 2-cycle toggle)', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'a'));
        f.record(sel('p', 'b'));
        f.record(sel('p', 'c')); // ordered: [c, b, a]

        // cursor starts at 0 (c); next -> b -> a -> wrap c
        expect(selectionKey(f.next() ?? sel('_', '_'))).toBe('p/b');
        expect(selectionKey(f.next() ?? sel('_', '_'))).toBe('p/a');
        expect(selectionKey(f.next() ?? sel('_', '_'))).toBe('p/c');
        // order unchanged after walking
        expect(f.ordered().map(selectionKey)).toEqual(['p/c', 'p/b', 'p/a']);
    });

    it('prev walks backward and wraps', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'a'));
        f.record(sel('p', 'b'));
        f.record(sel('p', 'c')); // ordered: [c, b, a], cursor 0

        // prev from 0 wraps to the last entry (a)
        expect(selectionKey(f.prev() ?? sel('_', '_'))).toBe('p/a');
        expect(selectionKey(f.prev() ?? sel('_', '_'))).toBe('p/b');
        expect(selectionKey(f.prev() ?? sel('_', '_'))).toBe('p/c');
    });

    it('next/prev return undefined when only one entry is recorded', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'a'));

        expect(f.next()).toBeUndefined();
        expect(f.prev()).toBeUndefined();
    });

    it('record resets the cursor to the front (most recent)', () => {
        const f = new ModelFrecency();
        f.record(sel('p', 'a'));
        f.record(sel('p', 'b'));
        f.record(sel('p', 'c')); // [c, b, a]
        f.next(); // cursor now 1 (b)

        f.record(sel('p', 'a')); // [a, c, b], cursor 0
        expect(selectionKey(f.next() ?? sel('_', '_'))).toBe('p/c');
    });

    it('seedFrom initializes from a list without reordering semantics', () => {
        const f = new ModelFrecency();
        f.seedFrom([sel('p', 'x'), sel('p', 'y'), sel('p', 'z')]);

        expect(f.ordered().map(selectionKey)).toEqual(['p/x', 'p/y', 'p/z']);
        expect(selectionKey(f.next() ?? sel('_', '_'))).toBe('p/y');
    });
});

// ---------------------------------------------------------------------------
// ModelFavorites
// ---------------------------------------------------------------------------

describe('ModelFavorites', () => {
    it('set/get round-trips a slot in 1..9', () => {
        const fav = new ModelFavorites();
        fav.set(1, sel('p', 'm1'));
        fav.set(9, sel('p', 'm9'));

        expect(fav.get(1)).toEqual(sel('p', 'm1'));
        expect(fav.get(9)).toEqual(sel('p', 'm9'));
    });

    it('get returns undefined for an empty slot (documented no-op)', () => {
        const fav = new ModelFavorites();
        expect(fav.get(1)).toBeUndefined();
        expect(fav.get(5)).toBeUndefined();
    });

    it('clear empties a slot', () => {
        const fav = new ModelFavorites();
        fav.set(3, sel('p', 'm3'));
        fav.clear(3);

        expect(fav.get(3)).toBeUndefined();
    });

    it('set overwrites a previously-set slot', () => {
        const fav = new ModelFavorites();
        fav.set(2, sel('p', 'old'));
        fav.set(2, sel('p', 'new'));

        expect(fav.get(2)).toEqual(sel('p', 'new'));
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch
// ---------------------------------------------------------------------------

interface SpyDeps extends ModelShortcutsDeps {
    readonly selected: ModelProviderSelection[];
    readonly notices: string[];
}

function buildSpyDeps(overrides: Partial<Omit<ModelShortcutsDeps, 'frecency' | 'favorites'>> = {}): SpyDeps {
    const selected: ModelProviderSelection[] = [];
    const notices: string[] = [];
    return {
        selected,
        notices,
        frecency: new ModelFrecency(),
        favorites: new ModelFavorites(),
        getModelSelections: overrides.getModelSelections ?? (() => []),
        getCurrentSelection: overrides.getCurrentSelection ?? (() => undefined),
        selectModel: (selection) => selected.push(selection),
        emitNotice: (text) => notices.push(text),
    };
}

describe('T11 model shortcuts layer — F2 recent cycle', () => {
    it('F2 (model.cycle_recent) selects the next recently-used model (acceptance a, misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps();
        deps.frecency.record(sel('p', 'a'));
        deps.frecency.record(sel('p', 'b'));
        deps.frecency.record(sel('p', 'c')); // ordered: [c, b, a]
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2');

        // EXACT selection, not just "a call happened": next after c is b.
        expect(deps.selected).toEqual([sel('p', 'b')]);
        expect(deps.notices).toEqual([]);

        off();
        harness.cleanup();
    });

    it('Shift+F2 (model.cycle_recent.reverse) selects the previous recently-used model', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps();
        deps.frecency.record(sel('p', 'a'));
        deps.frecency.record(sel('p', 'b'));
        deps.frecency.record(sel('p', 'c')); // ordered: [c, b, a], cursor 0
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2', { shift: true });

        // prev from cursor 0 wraps to the last entry (a).
        expect(deps.selected).toEqual([sel('p', 'a')]);

        off();
        harness.cleanup();
    });

    it('repeated F2 walks forward through the whole frecency without toggling two', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps();
        deps.frecency.record(sel('p', 'a'));
        deps.frecency.record(sel('p', 'b'));
        deps.frecency.record(sel('p', 'c')); // [c, b, a]
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2'); // -> b
        harness.host.press('f2'); // -> a
        harness.host.press('f2'); // -> c (wrap)

        expect(deps.selected.map(selectionKey)).toEqual(['p/b', 'p/a', 'p/c']);

        off();
        harness.cleanup();
    });

    it('F2 with an empty frecency and no model list is a no-op + notice (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps();
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2');

        expect(deps.selected).toEqual([]);
        expect(deps.notices.length).toBe(1);

        off();
        harness.cleanup();
    });

    it('F2 lazily seeds the frecency from the model list when empty, then cycles', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps({
            getModelSelections: () => [sel('p', 'x'), sel('p', 'y'), sel('p', 'z')],
        });
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2'); // seeds [x,y,z], next -> y

        expect(deps.selected).toEqual([sel('p', 'y')]);

        off();
        harness.cleanup();
    });

    it('F2 seeds the current model first, so the first cycle skips the active model', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = buildSpyDeps({
            getModelSelections: () => [sel('p', 'x'), sel('p', 'y'), sel('p', 'z')],
            getCurrentSelection: () => sel('p', 'z'),
        });
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('f2'); // seeds [z,x,y] (z current-first), next -> x

        expect(deps.selected).toEqual([sel('p', 'x')]);

        off();
        harness.cleanup();
    });
});

describe('T11 model shortcuts layer — leader+1..9 quick switch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leader+1 (model.quick_switch.1) jumps to the slot-1 favorite (acceptance b, misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });
        const deps = buildSpyDeps();
        deps.favorites.set(1, sel('anthropic', 'claude'));
        deps.favorites.set(2, sel('openai', 'gpt'));
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('x', { ctrl: true }); // arm leader
        harness.host.press('1');

        // EXACT slot-1 favorite, not just "fired".
        expect(deps.selected).toEqual([sel('anthropic', 'claude')]);
        expect(deps.notices).toEqual([]);

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+2 jumps to the slot-2 favorite (distinct from slot 1)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });
        const deps = buildSpyDeps();
        deps.favorites.set(1, sel('anthropic', 'claude'));
        deps.favorites.set(2, sel('openai', 'gpt'));
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('x', { ctrl: true });
        harness.host.press('2');

        expect(deps.selected).toEqual([sel('openai', 'gpt')]);

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+3 on an EMPTY slot is a documented no-op: no selection, emits a notice (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });
        const deps = buildSpyDeps();
        // slot 3 intentionally left empty
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('x', { ctrl: true });
        harness.host.press('3');

        expect(deps.selected).toEqual([]);
        expect(deps.notices.length).toBe(1);
        expect(deps.notices[0]).toContain('3');

        off();
        offLeader();
        harness.cleanup();
    });

    it('a favorites jump records into the frecency so subsequent F2 reflects it (frecency updates)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });
        const deps = buildSpyDeps();
        deps.frecency.record(sel('p', 'a'));
        deps.frecency.record(sel('p', 'b')); // ordered: [b, a]
        deps.favorites.set(1, sel('p', 'z'));
        const off = registerModelShortcutsLayer(harness.keymap, deps);

        harness.host.press('x', { ctrl: true });
        harness.host.press('1'); // jumps to z, records z -> frecency [z, b, a]

        // The jumped model is now the most-recent, so F2 next returns the
        // previous front (b).
        harness.host.press('f2');

        expect(deps.selected.map(selectionKey)).toEqual(['p/z', 'p/b']);

        off();
        offLeader();
        harness.cleanup();
    });
});
