/**
 * T6 contract tests: pin the resolved chord conflicts.
 *
 * The chord VALUES were already resolved by T2 (keybind.ts) + T3 (filtered
 * binding set excludes ctrl+e/ctrl+z/home/end) + T4 (config-driven sourcing) +
 * T17 (registry-driven /hotkeys). T6 changes NO source: it PINS the resolution
 * against future drift and documents it. This file is the regression contract.
 *
 * Conflict resolution pinned here (the app layer owns the bare chord; the input
 * layer restored the equivalent on a non-colliding chord so the textarea still
 * gets the behavior):
 *  - ctrl+e    -> editor_open (app). line-end restored on ctrl+shift+e (input).
 *  - ctrl+z    -> terminal_suspend (app). undo/redo on ctrl+- / ctrl+.
 *  - home/end  -> transcript scroll (app). buffer-home/end on ctrl+shift+home/end.
 *  - ctrl+p    -> model_cycle (unchanged; the palette is alt+x, NOT ctrl+p).
 *  - ctrl+g    -> abg_overlay_toggle (app). messages_first is ctrl+shift+home,
 *                 NOT ctrl+g, so there is no ABG-overlay collision.
 *
 * The `messages_first` / `input_buffer_home` overlap on ctrl+shift+home is
 * INTENTIONAL and resolved by LAYER PRIORITY (T10: input.* wins while the
 * textarea is focused; messages.* wins while it is blurred), not a conflict.
 *
 * Adversarial coverage:
 *  - misleading_success_output: APPLIES — every assertion pins the EXACT chord
 *    string, not merely "a chord is present".
 *  - malformed_input / stale_state / flaky_tests / prompt_injection /
 *    cancel_resume / dirty_worktree / hung_commands / repeated_interruptions:
 *    N/A — pure data/config module, no runtime, no I/O, no async.
 */

import { describe, expect, it } from 'vitest';
import { expandToChords, inputBindingsFromKeybinds, type KeybindName, Keybinds } from './keybind.js';
import {
    createConfigDrivenTextareaBindings,
    EXCLUDED_TEXTAREA_CHORDS,
    filterTextareaBindings,
    type TextareaBindingLike,
} from './keymap-managed-layer.js';

const defaults = Keybinds.parse({});

describe('T6 resolved chord conflicts — app layer owns the bare chord', () => {
    describe('ctrl+e -> editor_open (NOT input line-end)', () => {
        it('editor_open defaults to exactly ctrl+e', () => {
            expect(defaults.editor_open).toBe('ctrl+e');
        });
        it('input_line_end was moved off ctrl+e to exactly ctrl+shift+e', () => {
            expect(defaults.input_line_end).toBe('ctrl+shift+e');
        });
        it('input line-end never binds the bare ctrl+e the app layer owns', () => {
            const lineEndChords = expandToChords(defaults.input_line_end);
            expect(lineEndChords).not.toContain('ctrl+e');
        });
    });

    describe('ctrl+z -> terminal_suspend (NOT input undo)', () => {
        it('terminal_suspend defaults to exactly ctrl+z', () => {
            expect(defaults.terminal_suspend).toBe('ctrl+z');
        });
        it('input_undo was moved off ctrl+z to exactly ctrl+-', () => {
            expect(defaults.input_undo).toBe('ctrl+-');
        });
        it('input_redo defaults to exactly ctrl+. (NOT ctrl+z)', () => {
            expect(defaults.input_redo).toBe('ctrl+.');
        });
        it('undo/redo never bind the bare ctrl+z the app layer owns', () => {
            expect(expandToChords(defaults.input_undo)).not.toContain('ctrl+z');
            expect(expandToChords(defaults.input_redo)).not.toContain('ctrl+z');
        });
    });

    describe('home/end -> transcript scroll (NOT input buffer-home/end)', () => {
        it('input_buffer_home was moved off bare home to exactly ctrl+shift+home', () => {
            expect(defaults.input_buffer_home).toBe('ctrl+shift+home');
        });
        it('input_buffer_end was moved off bare end to exactly ctrl+shift+end', () => {
            expect(defaults.input_buffer_end).toBe('ctrl+shift+end');
        });
        it('buffer-home/end never bind the bare home/end the app layer owns', () => {
            expect(expandToChords(defaults.input_buffer_home)).not.toContain('home');
            expect(expandToChords(defaults.input_buffer_end)).not.toContain('end');
        });
    });

    describe('ctrl+p -> model_cycle (unchanged; palette is alt+x)', () => {
        it('model_cycle defaults to exactly ctrl+p', () => {
            expect(defaults.model_cycle).toBe('ctrl+p');
        });
        it('command_list (palette) is alt+x, NOT ctrl+p', () => {
            expect(defaults.command_list).toBe('alt+x');
            expect(defaults.command_list).not.toBe('ctrl+p');
        });
    });
});

describe('T6 no ABG-overlay collision on messages_first', () => {
    it('abg_overlay_toggle defaults to exactly ctrl+g', () => {
        expect(defaults.abg_overlay_toggle).toBe('ctrl+g');
    });
    it('messages_first defaults to exactly ctrl+shift+home (NOT ctrl+g)', () => {
        expect(defaults.messages_first).toBe('ctrl+shift+home');
    });
    it('messages_first never resolves to the ctrl+g owned by the ABG overlay', () => {
        expect(expandToChords(defaults.messages_first)).not.toContain('ctrl+g');
    });
    it('abg_overlay_toggle never resolves to ctrl+shift+home', () => {
        expect(expandToChords(defaults.abg_overlay_toggle)).not.toContain('ctrl+shift+home');
    });
});

describe('T6 messages_first / input_buffer_home overlap is intentional (layer priority)', () => {
    // Both bind ctrl+shift+home. This is the T10 resolution: input.* (priority 0)
    // wins while the textarea is focused; messages.* (priority -100) wins while
    // blurred. Not a bug — pinned here so a future rebind does not silently
    // collapse the two into one behavior.
    it('both messages_first and input_buffer_home bind ctrl+shift+home', () => {
        expect(expandToChords(defaults.messages_first)).toContain('ctrl+shift+home');
        expect(expandToChords(defaults.input_buffer_home)).toContain('ctrl+shift+home');
    });
    it('messages_first and input_buffer_home are separate registry entries', () => {
        const names = Object.keys(Keybinds.parse({})) as KeybindName[];
        expect(names).toContain('messages_first');
        expect(names).toContain('input_buffer_home');
    });
});

describe('T6 EXCLUDED_TEXTAREA_CHORDS pins the four app-owned chords', () => {
    it('excludes ctrl+e so the app layer owns editor_open', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('ctrl+e');
    });
    it('excludes ctrl+z so the app layer owns terminal_suspend', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('ctrl+z');
    });
    it('excludes home so the app layer owns transcript scroll-to-top', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('home');
    });
    it('excludes end so the app layer owns transcript scroll-to-bottom', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('end');
    });
    it('does NOT exclude ctrl+shift+home/ctrl+shift+end (input still owns them)', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).not.toContain('ctrl+shift+home');
        expect(EXCLUDED_TEXTAREA_CHORDS).not.toContain('ctrl+shift+end');
    });
});

describe('T6 the live filtered textarea binding set has zero app-layer collisions', () => {
    // The strongest contract: walk the config-driven binding set that the
    // managed textarea layer actually registers, and assert none of its keys
    // collide with the four app-owned chords. This proves the app layer owns
    // them at runtime, not just at the catalog level.
    const filtered = createConfigDrivenTextareaBindings();
    const filteredKeys = filtered.map((binding) => binding.key);

    it('produces a non-empty binding set to assert over', () => {
        expect(filteredKeys.length).toBeGreaterThan(0);
    });

    it.each([
        ['ctrl+e', 'editor_open'],
        ['ctrl+z', 'terminal_suspend'],
        ['home', 'transcript scroll-to-top'],
        ['end', 'transcript scroll-to-bottom'],
    ])('the filtered textarea set does NOT bind %s (app owns %s)', (chord) => {
        expect(filteredKeys).not.toContain(chord);
    });

    it('still binds ctrl+shift+e as input.line.end (line-end restored)', () => {
        const lineEnd = filtered.find((binding) => binding.cmd === 'input.line.end' && binding.key === 'ctrl+shift+e');
        expect(lineEnd).toBeDefined();
    });

    it('still binds ctrl+- as input.undo and ctrl+. as input.redo', () => {
        const undo = filtered.find((binding) => binding.cmd === 'input.undo' && binding.key === 'ctrl+-');
        const redo = filtered.find((binding) => binding.cmd === 'input.redo' && binding.key === 'ctrl+.');
        expect(undo).toBeDefined();
        expect(redo).toBeDefined();
    });

    it('still binds ctrl+shift+home/ctrl+shift+end as buffer-home/end', () => {
        const home = filtered.find(
            (binding) => binding.cmd === 'input.buffer.home' && binding.key === 'ctrl+shift+home',
        );
        const end = filtered.find((binding) => binding.cmd === 'input.buffer.end' && binding.key === 'ctrl+shift+end');
        expect(home).toBeDefined();
        expect(end).toBeDefined();
    });
});

describe('T6 filterTextareaBindings is the exclusion mechanism', () => {
    // Pins that filterTextareaBindings is what strips the four chords, and that
    // it leaves non-colliding chords (including the restored equivalents)
    // untouched.
    it('strips a ctrl+e binding but keeps ctrl+shift+e', () => {
        const sample: TextareaBindingLike[] = [
            { key: 'ctrl+e', cmd: 'input.line.end' },
            { key: 'ctrl+shift+e', cmd: 'input.line.end' },
        ];
        const keys = filterTextareaBindings(sample).map((binding) =>
            typeof binding.key === 'string' ? binding.key : '',
        );
        expect(keys).not.toContain('ctrl+e');
        expect(keys).toContain('ctrl+shift+e');
    });

    it('strips ctrl+z/home/end but keeps ctrl+-, ctrl+., ctrl+shift+home, ctrl+shift+end', () => {
        const sample: TextareaBindingLike[] = [
            { key: 'ctrl+z', cmd: 'input.undo' },
            { key: 'ctrl+-', cmd: 'input.undo' },
            { key: 'ctrl+.', cmd: 'input.redo' },
            { key: 'home', cmd: 'input.buffer.home' },
            { key: 'ctrl+shift+home', cmd: 'input.buffer.home' },
            { key: 'end', cmd: 'input.buffer.end' },
            { key: 'ctrl+shift+end', cmd: 'input.buffer.end' },
        ];
        const keys = filterTextareaBindings(sample).map((binding) =>
            typeof binding.key === 'string' ? binding.key : '',
        );
        expect(keys).toEqual(expect.arrayContaining(['ctrl+-', 'ctrl+.', 'ctrl+shift+home', 'ctrl+shift+end']));
        expect(keys).not.toContain('ctrl+z');
        expect(keys).not.toContain('home');
        expect(keys).not.toContain('end');
    });
});

describe('T6 inputBindingsFromKeybinds is config-driven and complete', () => {
    // Confirms the input namespace is sourced from the registry (not a fixed
    // addon default list), so the resolved chords flow end-to-end.
    const inputBindings = inputBindingsFromKeybinds(defaults);
    const commands = new Set(inputBindings.map((binding) => binding.cmd));

    it('emits bindings for the restored input commands', () => {
        expect(commands.has('input.line.end')).toBe(true);
        expect(commands.has('input.undo')).toBe(true);
        expect(commands.has('input.redo')).toBe(true);
        expect(commands.has('input.buffer.home')).toBe(true);
        expect(commands.has('input.buffer.end')).toBe(true);
    });

    it('never emits the chat-level app actions (those live outside input.*)', () => {
        expect(commands.has('editor.open')).toBe(false);
        expect(commands.has('terminal.suspend')).toBe(false);
        expect(commands.has('model.cycle')).toBe(false);
        expect(commands.has('abg.overlay.toggle')).toBe(false);
    });
});
