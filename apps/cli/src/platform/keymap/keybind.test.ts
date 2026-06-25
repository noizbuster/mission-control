/**
 * T2 failing-first proof for the mctrl keybind config registry.
 *
 * This is a PURE data/config module test: no keymap instance, no renderer, no
 * React. It asserts the five T2 acceptance criteria plus the two applicable
 * adversarial classes (malformed_input, misleading_success_output). The
 * remaining adversarial classes are N/A for a stateless config table:
 *  - stale_state / flaky_tests: no mutable state, no async, no clock.
 *  - prompt_injection / cancel_resume / dirty_worktree / hung_commands /
 *    repeated_interruptions: no runtime, no I/O, no process control surface.
 *
 * Written BEFORE keybind.ts; the `./keybind.js` import fails until the module
 * exists, which is the red half of the red->green->refactor loop.
 */

import { describe, expect, it } from 'vitest';
import {
    bindingDefaults,
    CommandMap,
    Definitions,
    type KeybindName,
    type KeybindOverrides,
    Keybinds,
    unknownKeys,
} from './keybind.js';

/** Flatten any binding value to a single comparable string for chord checks. */
function bindingChords(value: unknown): string {
    if (Array.isArray(value)) return value.map((item) => bindingChords(item)).join(',');
    if (typeof value === 'string') return value;
    if (value === false || value === null) return '';
    if (typeof value === 'object' && value !== null) {
        const obj = value as { key?: unknown; name?: unknown };
        if (typeof obj.key === 'string') return obj.key;
        if (typeof obj.name === 'string') return obj.name;
    }
    return '';
}

describe('mctrl keybind registry', () => {
    describe('acceptance (a): parse({}) returns all mctrl-kept defaults', () => {
        const defaults = Keybinds.parse({});

        it('keeps ctrl+p as model_cycle', () => {
            expect(defaults.model_cycle).toBe('ctrl+p');
        });
        it('keeps ctrl+t as thinking_toggle', () => {
            expect(defaults.thinking_toggle).toBe('ctrl+t');
        });
        it('keeps ctrl+o as tool_expand', () => {
            expect(defaults.tool_expand).toBe('ctrl+o');
        });
        it('keeps ctrl+e as editor_open', () => {
            expect(defaults.editor_open).toBe('ctrl+e');
        });
        it('keeps ctrl+z as terminal_suspend', () => {
            expect(defaults.terminal_suspend).toBe('ctrl+z');
        });
        it('keeps ctrl+r as session_rename', () => {
            expect(defaults.session_rename).toBe('ctrl+r');
        });
        it('keeps ctrl+v as clipboard_paste_image', () => {
            expect(defaults.clipboard_paste_image).toBe('ctrl+v');
        });
        it('keeps ctrl+g as abg_overlay_toggle', () => {
            expect(defaults.abg_overlay_toggle).toBe('ctrl+g');
        });
    });

    describe('acceptance (b): overrides merge over defaults (misleading_success guard)', () => {
        it('returns the OVERRIDDEN value, not just a non-throwing parse', () => {
            const overridden = Keybinds.parse({ model_cycle: 'f2' });
            expect(overridden.model_cycle).toBe('f2');
        });
        it('leaves non-overridden defaults untouched', () => {
            const overridden = Keybinds.parse({ model_cycle: 'f2' });
            expect(overridden.thinking_toggle).toBe('ctrl+t');
            expect(overridden.leader).toBe('ctrl+x');
        });
        it('accepts the "none" disable value', () => {
            const overridden = Keybinds.parse({ tool_expand: 'none' });
            expect(overridden.tool_expand).toBe('none');
        });
        it('accepts false as a disable value', () => {
            const overridden = Keybinds.parse({ thinking_toggle: false });
            expect(overridden.thinking_toggle).toBe(false);
        });
    });

    describe('acceptance (c): NO input.* command maps to bare ctrl+c (Ctrl+C invariant)', () => {
        const defaults = Keybinds.parse({});
        const inputNames = (Object.keys(defaults) as KeybindName[]).filter((name) => name.startsWith('input_'));

        it('has a non-empty input namespace to assert over', () => {
            expect(inputNames.length).toBeGreaterThan(0);
        });

        it.each(inputNames)('input command %s does NOT bind ctrl+c', (name) => {
            const chords = bindingChords(defaults[name]);
            const alternatives = chords.split(',').map((token) => token.trim());
            expect(alternatives).not.toContain('ctrl+c');
        });

        it('does not expose an input_clear command at all', () => {
            expect(Object.keys(Definitions) as KeybindName[]).not.toContain('input_clear');
        });
    });

    describe('acceptance (d): leader === ctrl+x', () => {
        it('default leader is ctrl+x', () => {
            expect(Keybinds.parse({}).leader).toBe('ctrl+x');
        });
        it('leader is overridable', () => {
            expect(Keybinds.parse({ leader: 'ctrl+space' }).leader).toBe('ctrl+space');
        });
    });

    describe('acceptance (e): command_list (palette) === alt+x (NOT ctrl+p)', () => {
        it('default command_list is alt+x', () => {
            expect(Keybinds.parse({}).command_list).toBe('alt+x');
        });
        it('command_list is NOT ctrl+p (ctrl+p stays model_cycle)', () => {
            expect(Keybinds.parse({}).command_list).not.toBe('ctrl+p');
        });
    });

    describe('malformed_input: unknown keys throw', () => {
        // The realistic source of unknown keys is a config FILE (T17 loader),
        // so the overrides are routed through `JSON.parse` — exactly what a
        // JSON config loader hands to `parse`. `JSON.parse` returns `any`
        // (stdlib), assignable to `KeybindOverrides` with no cast, and bypasses
        // the fresh-literal excess-property check so the RUNTIME rejection
        // path is what gets exercised.
        it('unknownKeys lists keys not in Definitions', () => {
            expect(unknownKeys({ nonexistent_key: 'x' })).toEqual(['nonexistent_key']);
        });
        it('unknownKeys is empty for a fully-known override set', () => {
            expect(unknownKeys({ model_cycle: 'f2', leader: 'ctrl+x' })).toEqual([]);
        });
        it('parse throws singular "Unrecognized keybind" for one unknown key', () => {
            const fromFile: KeybindOverrides = JSON.parse('{"nonexistent_key":"x"}');
            expect(() => Keybinds.parse(fromFile)).toThrowError(/Unrecognized keybind: nonexistent_key/);
        });
        it('parse throws plural "Unrecognized keybinds" for multiple unknown keys', () => {
            const fromFile: KeybindOverrides = JSON.parse('{"a":"x","b":"y"}');
            expect(() => Keybinds.parse(fromFile)).toThrowError(/Unrecognized keybinds: a, b/);
        });
        it('parse rejects a malformed binding value (number) instead of silently passing', () => {
            const fromFile: KeybindOverrides = JSON.parse('{"model_cycle":42}');
            expect(() => Keybinds.parse(fromFile)).toThrowError(/model_cycle/);
        });
    });

    describe('CommandMap shape', () => {
        it('maps command_list to command.palette.show', () => {
            expect(CommandMap.command_list).toBe('command.palette.show');
        });
        it('maps model_cycle to model.cycle', () => {
            expect(CommandMap.model_cycle).toBe('model.cycle');
        });
        it('every keybind name (except leader, which is a token) maps to a command id', () => {
            const names = Object.keys(Definitions) as KeybindName[];
            for (const name of names) {
                if (name === 'leader') continue;
                expect(CommandMap[name as keyof typeof CommandMap]).toBeDefined();
            }
        });
        it('leader is intentionally absent from CommandMap (token, not a dispatch command)', () => {
            expect('leader' in CommandMap).toBe(false);
        });
    });

    describe('bindingDefaults', () => {
        it('returns a function that fills desc from CommandDescriptions', () => {
            const defaults = bindingDefaults();
            expect(typeof defaults).toBe('function');
            const result = defaults({
                command: CommandMap.model_cycle,
                binding: { desc: undefined } as unknown as Parameters<typeof defaults>[0]['binding'],
            });
            expect(result).toEqual({ desc: Definitions.model_cycle.description });
        });
        it('is a no-op when the binding already carries a desc', () => {
            const defaults = bindingDefaults();
            const result = defaults({
                command: CommandMap.model_cycle,
                binding: { desc: 'preset' } as unknown as Parameters<typeof defaults>[0]['binding'],
            });
            expect(result).toBeUndefined();
        });
    });
});
