/**
 * T9 failing-first proof: which-key panel base-mode binding display +
 * toggle/layout layer dispatch + mode-stack push/pop.
 *
 * The which-key panel component (which-key-panel.tsx) cannot be rendered in
 * unit tests (no react-dom / react-test-renderer / DOM env; the plan forbids
 * adding deps). Its module IS FFI-safe to import, though: it pulls only
 * `@opentui/keymap/react` (FFI-free, verified in T3 learnings) and the
 * jsx-runtime (a one-line re-export of react's jsx-runtime, verified), never
 * `@opentui/react` main. So this suite drives the PURE projection/grouping
 * helpers + the layer registration against a REAL `createTestKeymap` (pure JS,
 * no native FFI), mirroring the T8/T10 pattern.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert the panel projects REAL reachable
 *    bindings (chord + description, exact strings), not just "non-empty"; and
 *    that a mode push CHANGES the displayed set (different entries), not
 *    "still toggled".
 *  - stale_state: pushMode/popMode keep currentMode consistent; a mode-tagged
 *    command appears ONLY in its own mode, never in base.
 *  - malformed_input: projectWhichKeyEntries on an empty list is a clean
 *    empty-groups result (no throw).
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { describe, expect, it } from 'vitest';
import { BASE_MODE, currentMode, type ModeStack, popMode, pushMode } from './mode-stack.js';
import {
    formatSequence,
    groupEntries,
    nextLayout,
    projectWhichKeyEntries,
    registerWhichKeyLayer,
    WHICH_KEY_LAYOUT_COMMAND,
    WHICH_KEY_TOGGLE_COMMAND,
} from './which-key-panel.js';

/** Flatten grouped entries to "chord|label" strings for exact assertions. */
function flatGroups(
    groups: ReadonlyArray<{ readonly entries: ReadonlyArray<{ readonly key: string; readonly label: string }> }>,
): string[] {
    const out: string[] = [];
    for (const group of groups) {
        for (const entry of group.entries) {
            out.push(`${entry.key}|${entry.label}`);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Pure helpers: layout, sequence formatting, grouping
// ---------------------------------------------------------------------------

describe('nextLayout', () => {
    it('cycles dock -> overlay -> dock (acceptance c)', () => {
        expect(nextLayout('dock')).toBe('overlay');
        expect(nextLayout('overlay')).toBe('dock');
    });
});

describe('formatSequence', () => {
    it('joins part display strings with a space', () => {
        expect(formatSequence([{ display: 'ctrl+p' }])).toBe('ctrl+p');
        expect(formatSequence([{ display: 'ctrl+x' }, { display: 'm' }])).toBe('ctrl+x m');
    });

    it('skips empty display parts', () => {
        expect(formatSequence([{ display: '' }, { display: 'k' }])).toBe('k');
        expect(formatSequence([])).toBe('');
    });
});

describe('groupEntries', () => {
    it('groups by the entry group field and sorts (group, then label, then key)', () => {
        const groups = groupEntries([
            { key: 'ctrl+p', label: 'Cycle model', group: 'model' },
            { key: 'ctrl+x', label: 'New session', group: 'session' },
            { key: 'f2', label: 'Recent model', group: 'model' },
        ]);
        expect(groups.map((group) => group.label)).toEqual(['model', 'session']);
        const model = groups[0];
        if (model === undefined) throw new Error('missing model group');
        // Within "model": "Cycle model" < "Recent model" (C < R).
        expect(model.entries.map((entry) => `${entry.key}|${entry.label}`)).toEqual([
            'ctrl+p|Cycle model',
            'f2|Recent model',
        ]);
    });

    it('returns an empty array for no entries (malformed-input guard)', () => {
        expect(groupEntries([])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// projectWhichKeyEntries: REAL keymap entries, mode filtering, self-exclusion
// ---------------------------------------------------------------------------

describe('projectWhichKeyEntries — base mode (acceptance a)', () => {
    it('projects REAL reachable bindings with exact chord + description (misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        harness.keymap.registerLayer({
            commands: [
                { name: 'model.cycle', run: () => true, title: 'Cycle model', desc: 'Cycle to next model' },
                { name: 'session.new', run: () => true, desc: 'Create a new session' },
            ],
            bindings: [
                { key: 'ctrl+p', cmd: 'model.cycle' },
                { key: 'ctrl+x', cmd: 'session.new' },
            ],
        });

        const entries = harness.keymap.getCommandEntries({ visibility: 'reachable' });
        const groups = projectWhichKeyEntries(entries, BASE_MODE);

        // EXACT chord + description, not just "non-empty".
        expect(flatGroups(groups)).toEqual(['ctrl+p|Cycle model', 'ctrl+x|Create a new session']);
        // Grouped by command namespace: model.cycle -> "model", session.new -> "session".
        expect(groups.map((group) => group.label)).toEqual(['model', 'session']);

        harness.cleanup();
    });

    it("excludes the panel's own toggle/layout commands from the display", () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const off = registerWhichKeyLayer(harness.keymap, {
            onToggle: () => {},
            onLayoutToggle: () => {},
        });

        const entries = harness.keymap.getCommandEntries({ visibility: 'reachable' });
        // The toggle/layout commands ARE reachable in the keymap...
        const names = entries.map((entry) => entry.command.name);
        expect(names).toContain(WHICH_KEY_TOGGLE_COMMAND);
        expect(names).toContain(WHICH_KEY_LAYOUT_COMMAND);
        // ...but MUST NOT surface in their own panel (self-exclusion, mirrors T8 palette).
        expect(projectWhichKeyEntries(entries, BASE_MODE)).toEqual([]);

        off();
        harness.cleanup();
    });

    it('ignores commands marked hidden', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        harness.keymap.registerLayer({
            commands: [
                { name: 'shown.cmd', run: () => true, desc: 'Shown' },
                { name: 'hidden.cmd', run: () => true, desc: 'Hidden', hidden: true },
            ],
            bindings: [
                { key: 'f1', cmd: 'shown.cmd' },
                { key: 'f2', cmd: 'hidden.cmd' },
            ],
        });
        const entries = harness.keymap.getCommandEntries({ visibility: 'reachable' });
        expect(flatGroups(projectWhichKeyEntries(entries, BASE_MODE))).toEqual(['f1|Shown']);
        harness.cleanup();
    });
});

describe('projectWhichKeyEntries — mode push changes the set (acceptance b, stale-state guard)', () => {
    it('a base command shows in base mode; a mode-tagged command shows ONLY in its mode', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        harness.keymap.registerLayer({
            commands: [
                { name: 'model.cycle', run: () => true, desc: 'Cycle model' },
                { name: 'autocomplete.next', run: () => true, desc: 'Next suggestion', mode: 'autocomplete' },
            ],
            bindings: [
                { key: 'ctrl+p', cmd: 'model.cycle' },
                { key: 'down', cmd: 'autocomplete.next' },
            ],
        });

        const entries = harness.keymap.getCommandEntries({ visibility: 'reachable' });

        // Base mode: shows model.cycle, EXCLUDES autocomplete.next.
        const base = projectWhichKeyEntries(entries, BASE_MODE);
        expect(flatGroups(base)).toEqual(['ctrl+p|Cycle model']);

        // Pushing the autocomplete mode CHANGES the set: now ONLY autocomplete.next.
        const auto = projectWhichKeyEntries(entries, 'autocomplete');
        expect(flatGroups(auto)).toEqual(['down|Next suggestion']);

        harness.cleanup();
    });

    it('empty reachable list yields an empty groups result (no throw)', () => {
        expect(projectWhichKeyEntries([], BASE_MODE)).toEqual([]);
        expect(projectWhichKeyEntries([], 'autocomplete')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// mode-stack pure arithmetic
// ---------------------------------------------------------------------------

describe('mode-stack pure arithmetic', () => {
    it('currentMode defaults to base on an empty stack', () => {
        expect(currentMode([])).toBe(BASE_MODE);
    });

    it('pushMode appends and currentMode returns the top', () => {
        const one = pushMode([], 'autocomplete');
        expect(currentMode(one)).toBe('autocomplete');
        const two = pushMode(one, 'palette');
        expect(currentMode(two)).toBe('palette');
    });

    it('popMode removes the top and currentMode stays consistent down to base (stale-state guard)', () => {
        const stack: ModeStack = pushMode(pushMode([], 'autocomplete'), 'palette');
        expect(currentMode(stack)).toBe('palette');
        expect(currentMode(popMode(stack))).toBe('autocomplete');
        expect(currentMode(popMode(popMode(stack)))).toBe(BASE_MODE);
        // pop below the floor stays empty (currentMode still base).
        expect(popMode(popMode(popMode(stack)))).toEqual([]);
    });

    it('pushMode/popMode are immutable (do not mutate the input)', () => {
        const original: ModeStack = [];
        const pushed = pushMode(original, 'x');
        expect(original).toEqual([]);
        expect(pushed).toEqual(['x']);
    });
});

// ---------------------------------------------------------------------------
// registerWhichKeyLayer: toggle + layout dispatch on a REAL keymap
// ---------------------------------------------------------------------------

describe('registerWhichKeyLayer — toggle + layout dispatch (acceptance a/c)', () => {
    it('ctrl+alt+k fires the toggle command (acceptance a)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        let toggleCount = 0;
        let layoutCount = 0;
        const off = registerWhichKeyLayer(harness.keymap, {
            onToggle: () => {
                toggleCount += 1;
            },
            onLayoutToggle: () => {
                layoutCount += 1;
            },
        });

        // alt = meta in the keymap parser (T4 learning): ctrl+alt+k -> ctrl+meta+k.
        harness.host.press('k', { ctrl: true, meta: true });

        expect(toggleCount).toBe(1);
        expect(layoutCount).toBe(0);

        off();
        harness.cleanup();
    });

    it('ctrl+alt+shift+k fires the layout toggle command (acceptance c)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        let toggleCount = 0;
        let layoutCount = 0;
        const off = registerWhichKeyLayer(harness.keymap, {
            onToggle: () => {
                toggleCount += 1;
            },
            onLayoutToggle: () => {
                layoutCount += 1;
            },
        });

        harness.host.press('k', { ctrl: true, meta: true, shift: true });

        expect(layoutCount).toBe(1);
        expect(toggleCount).toBe(0);

        off();
        harness.cleanup();
    });

    it('tearing down the layer stops the chords from firing', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        let toggleCount = 0;
        const off = registerWhichKeyLayer(harness.keymap, {
            onToggle: () => {
                toggleCount += 1;
            },
            onLayoutToggle: () => {},
        });

        off();
        harness.host.press('k', { ctrl: true, meta: true });
        expect(toggleCount).toBe(0);

        harness.cleanup();
    });
});
