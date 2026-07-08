/**
 * T4 failing-first proof: config-driven rebindable input.* editing commands.
 *
 * T3 wired a FILTERED set of textarea bindings sourced from the fixed addon
 * `createTextareaBindings()`. T4 makes those input.* bindings config-driven
 * from the `keybind.ts` registry so T17's config-loader can rebind them by
 * editing the registry. This test proves the config-driven path BEFORE the
 * refactor (the `createConfigDrivenTextareaBindings` import fails until T4
 * lands → red), then proves rebinding, multi-chord expansion, the select-all
 * gap, the exclusion filter, and keymap-level dispatch (green).
 *
 * Adversarial classes:
 *  - misleading_success_output: APPLIES — we assert the OVERRIDDEN chord fires
 *    the command AND the old chord is absent (not just "an override registered").
 *  - malformed_input: minor — handled at the keybind.ts parse layer (T2); here
 *    we only consume valid Keybinds objects.
 *  - stale_state / flaky / prompt_injection / cancel_resume / dirty_worktree /
 *    hung / repeated: N/A — pure config-to-binding construction + synchronous
 *    keymap dispatch in a test harness; no async, no I/O, no process control.
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { describe, expect, it } from 'vitest';
import { CommandMap, type KeybindName, Keybinds } from './keybind.js';
import { createConfigDrivenTextareaBindings, EXCLUDED_TEXTAREA_CHORDS } from './keymap-managed-layer.js';

/** Collect all chord strings that map to a given command id. */
function chordsForCommand(
    bindings: readonly { readonly key: unknown; readonly cmd?: unknown }[],
    commandId: string,
): string[] {
    return bindings.filter((b) => b.cmd === commandId).map((b) => (typeof b.key === 'string' ? b.key : ''));
}

// ---------------------------------------------------------------------------
// (a) Config-driven defaults: chords from keybind.ts, not the fixed addon
// ---------------------------------------------------------------------------

describe('T4 (a) config-driven defaults sourced from keybind.ts', () => {
    it('ctrl+a resolves to input.line.home (not the addon default)', () => {
        const defaults = createConfigDrivenTextareaBindings();
        const chords = chordsForCommand(defaults, CommandMap.input_line_home);
        expect(chords).toContain('ctrl+a');
    });

    it('input.word.forward expands to all three chords from the registry', () => {
        const defaults = createConfigDrivenTextareaBindings();
        const chords = chordsForCommand(defaults, CommandMap.input_word_forward);
        expect(chords).toEqual(expect.arrayContaining(['alt+f', 'alt+right', 'ctrl+right']));
        expect(chords).toHaveLength(3);
    });

    it('input.word.backward expands to all three chords from the registry', () => {
        const defaults = createConfigDrivenTextareaBindings();
        const chords = chordsForCommand(defaults, CommandMap.input_word_backward);
        expect(chords).toEqual(expect.arrayContaining(['alt+b', 'alt+left', 'ctrl+left']));
        expect(chords).toHaveLength(3);
    });

    it('produces a non-empty binding set (the full input.* catalog is reachable)', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(defaults.length).toBeGreaterThan(20);
    });

    it('EXCLUDED_TEXTAREA_CHORDS are absent from the default set', () => {
        const defaults = createConfigDrivenTextareaBindings();
        const keys = defaults.map((b) => (typeof b.key === 'string' ? b.key : ''));
        for (const excluded of EXCLUDED_TEXTAREA_CHORDS) {
            expect(keys).not.toContain(excluded);
        }
    });
});

// ---------------------------------------------------------------------------
// (b) Config-driven rebinding: override changes the resolved chord
//     (misleading_success_output guard: old chord is ABSENT, not just "override
//     registered")
// ---------------------------------------------------------------------------

describe('T4 (b) rebinding input.line.home via config override', () => {
    it('default has ctrl+a; override to ctrl+shift+a removes ctrl+a', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(chordsForCommand(defaults, CommandMap.input_line_home)).toContain('ctrl+a');

        const overridden = createConfigDrivenTextareaBindings(Keybinds.parse({ input_line_home: 'ctrl+shift+a' }));
        const chords = chordsForCommand(overridden, CommandMap.input_line_home);

        // The NEW chord is present (misleading-success guard: assert the VALUE)
        expect(chords).toContain('ctrl+shift+a');
        // The OLD chord is GONE (not just shadowed — it was never in the set)
        expect(chords).not.toContain('ctrl+a');
    });

    it('override leaves non-overridden commands untouched', () => {
        const overridden = createConfigDrivenTextareaBindings(Keybinds.parse({ input_line_home: 'ctrl+shift+a' }));
        expect(chordsForCommand(overridden, CommandMap.input_move_left)).toContain('left');
        expect(chordsForCommand(overridden, CommandMap.input_move_right)).toContain('right');
        expect(chordsForCommand(overridden, CommandMap.input_backspace)).toContain('backspace');
    });

    it('rebinding word.forward to a single chord collapses the multi-chord set', () => {
        const overridden = createConfigDrivenTextareaBindings(Keybinds.parse({ input_word_forward: 'ctrl+right' }));
        const chords = chordsForCommand(overridden, CommandMap.input_word_forward);
        expect(chords).toEqual(['ctrl+right']);
    });
});

// ---------------------------------------------------------------------------
// (c) select_all gap: unbound by default, user-bindable
// ---------------------------------------------------------------------------

describe('T4 (c) input.select_all gap', () => {
    it('is in the Definitions registry (reachable for user binding)', () => {
        const names = Object.keys(CommandMap) as KeybindName[];
        expect(names).toContain('input_select_all');
        expect(CommandMap.input_select_all).toBe('input.select.all');
    });

    it('defaults to "none" → produces ZERO bindings', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(chordsForCommand(defaults, CommandMap.input_select_all)).toHaveLength(0);
    });

    it('can be user-bound (overriding "none" produces a binding)', () => {
        const overridden = createConfigDrivenTextareaBindings(Keybinds.parse({ input_select_all: 'ctrl+a' }));
        const chords = chordsForCommand(overridden, CommandMap.input_select_all);
        expect(chords).toEqual(['ctrl+a']);
    });
});

// ---------------------------------------------------------------------------
// (d) Full input.* command set coverage (fills gaps — select/visual variants)
// ---------------------------------------------------------------------------

describe('T4 (d) select and visual variants are in the config-driven set', () => {
    it('select-buffer-home/end (shift+home/shift+end) are present', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(chordsForCommand(defaults, CommandMap.input_select_buffer_home)).toContain('shift+home');
        expect(chordsForCommand(defaults, CommandMap.input_select_buffer_end)).toContain('shift+end');
    });

    it('select-line-home (ctrl+shift+a) is present', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(chordsForCommand(defaults, CommandMap.input_select_line_home)).toContain('ctrl+shift+a');
    });

    it('select-word-forward/backward are present', () => {
        const defaults = createConfigDrivenTextareaBindings();
        expect(chordsForCommand(defaults, CommandMap.input_select_word_forward).length).toBeGreaterThan(0);
        expect(chordsForCommand(defaults, CommandMap.input_select_word_backward).length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// (e) Keymap-level dispatch: real keymap resolves and dispatches commands
// ---------------------------------------------------------------------------

describe('T4 (e) keymap-level dispatch with config-driven bindings', () => {
    it('ctrl+a dispatches input.line.home on a real keymap', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const { keymap, host, root } = harness;
        host.focus(root);

        let fired: string | null = null;
        keymap.registerLayer({
            commands: [
                {
                    name: CommandMap.input_line_home,
                    run: () => {
                        fired = CommandMap.input_line_home;
                        return true;
                    },
                },
            ],
        });
        const offLayer = keymap.registerLayer({
            bindings: createConfigDrivenTextareaBindings(),
        });

        host.press('a', { ctrl: true });

        expect(fired).toBe(CommandMap.input_line_home);

        offLayer();
        harness.cleanup();
    });

    it('overridden ctrl+shift+a dispatches input.line.home (old chord does not)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const { keymap, host, root } = harness;
        host.focus(root);

        let fired: string | null = null;
        keymap.registerLayer({
            commands: [
                {
                    name: CommandMap.input_line_home,
                    run: () => {
                        fired = CommandMap.input_line_home;
                        return true;
                    },
                },
            ],
        });
        const overridden = createConfigDrivenTextareaBindings(Keybinds.parse({ input_line_home: 'ctrl+shift+a' }));
        const offLayer = keymap.registerLayer({
            bindings: overridden,
        });

        // New chord fires the command
        fired = null;
        host.press('a', { ctrl: true, shift: true });
        expect(fired).toBe(CommandMap.input_line_home);

        // Old chord does NOT fire the command (misleading-success guard)
        fired = null;
        host.press('a', { ctrl: true });
        expect(fired).toBeNull();

        offLayer();
        harness.cleanup();
    });

    it('input.word.forward fires on alt+f (alt is a meta alias)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const { keymap, host, root } = harness;
        host.focus(root);

        let fired: string | null = null;
        keymap.registerLayer({
            commands: [
                {
                    name: CommandMap.input_word_forward,
                    run: () => {
                        fired = CommandMap.input_word_forward;
                        return true;
                    },
                },
            ],
        });
        const offLayer = keymap.registerLayer({
            bindings: createConfigDrivenTextareaBindings(),
        });

        host.press('f', { meta: true });
        expect(fired).toBe(CommandMap.input_word_forward);

        offLayer();
        harness.cleanup();
    });
});
