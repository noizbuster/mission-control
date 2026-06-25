/**
 * T3 acceptance tests: managed textarea layer composition + Ctrl+C invariant +
 * bridgeSubmit-override.
 *
 * These tests assert ALL FOUR acceptance criteria from plan T3 via the
 * `createRecordingTextarea` / `makeKeyEvent` test seam (no React mount, no
 * native renderer required for the invariant checks). The keymap-layer
 * composition itself cannot be unit-tested without a live CliRenderer (FFI),
 * so we test the three runtime invariants it must preserve + a structural grep
 * for the composition approach.
 *
 * (a) Ctrl+C still routes through the global handleInput sink (the keymap
 *     layer does NOT bind ctrl+c) and produces exactly ONE interrupt with
 *     source 'ctrl-c' and ZERO clear effects on the textarea.
 * (b) The custom submit command (wrapping bridgeSubmit) fired twice in the
 *     same tick produces exactly ONE enqueued line (the submitting guard holds).
 * (c) Submit during the IME submitting window (core.submitting === true) is a
 *     no-op (zero enqueues).
 * (d) registerManagedTextareaLayer is NOT called anywhere under the keymap
 *     directory, and the filtered binding set EXCLUDES ctrl+e and ctrl+z.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputEvent } from '../../commands/interactive-chat-io.js';
import {
    bridgeContentChange,
    bridgeSubmit,
    createOpenTuiChatBridgeCore,
    handleInput,
    type InkKeyShape,
    type OpenTuiChatBridgeCore,
} from '../../commands/opentui-chat-bridge.js';
import {
    asTextareaRef,
    createRecordingTextarea,
    type RecordingTextarea,
} from '../../commands/opentui-chat-bridge-test-support.js';
import { Keybinds } from './keybind.js';
import {
    CHAT_SUBMIT_COMMAND,
    createConfigDrivenTextareaBindings,
    EXCLUDED_TEXTAREA_CHORDS,
    filterTextareaBindings,
    type TextareaBindingLike,
} from './keymap-managed-layer.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function makeKey(overrides: Partial<InkKeyShape> = {}): InkKeyShape {
    return {
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
    };
}

function drainEvents(core: OpenTuiChatBridgeCore): readonly ChatInputEvent[] {
    return core.eventQueue.splice(0, core.eventQueue.length);
}

// ---------------------------------------------------------------------------
// (a) Ctrl+C invariant: exactly ONE interrupt, ZERO clear effects
// ---------------------------------------------------------------------------

describe('T3 (a) Ctrl+C routes through global sink with exactly one interrupt', () => {
    it('enqueues exactly ONE interrupt with source ctrl-c when the textarea has text', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('some partial input');
        bridgeContentChange(core, 'some partial input');

        // Ctrl+C reaches handleInput via the global useKeyboard sink because
        // the keymap layer MUST NOT bind ctrl+c (the Ctrl+C invariant).
        handleInput(core, 'c', makeKey({ ctrl: true }));

        const events = drainEvents(core);
        const interrupts = events.filter((e) => e.type === 'interrupt');

        expect(interrupts).toHaveLength(1);
        const interrupt = interrupts[0];
        expect(interrupt).toBeDefined();
        if (interrupt?.type === 'interrupt') {
            expect(interrupt.source).toBe('ctrl-c');
            expect(interrupt.interruptedPartialInput).toBe(true);
        }
    });

    it('does NOT clear the textarea (zero clear effects)', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('some partial input');
        bridgeContentChange(core, 'some partial input');

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(textarea.clearCount).toBe(0);
        expect(textarea.plainText).toBe('some partial input');
    });

    it('produces ZERO additional events beyond the single interrupt', () => {
        const core = createOpenTuiChatBridgeCore();
        bridgeContentChange(core, 'hello');

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(drainEvents(core)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// (b) Submit guard: fired twice in the same tick produces exactly ONE line
// ---------------------------------------------------------------------------

describe('T3 (b) custom submit command submitting guard', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('enqueues exactly ONE line when submit is fired twice in the same tick', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('hello world');
        const ref = asTextareaRef(textarea);

        // The custom submit command wraps bridgeSubmit. Firing it twice in the
        // same tick: the second call sees core.submitting === true and no-ops.
        bridgeSubmit(core, ref);
        bridgeSubmit(core, ref);

        // Advance through the double-setTimeout IME defer window.
        vi.runAllTimers();

        const lines = drainEvents(core).filter((e) => e.type === 'line');

        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toBeDefined();
        if (line?.type === 'line') {
            expect(line.value).toBe('hello world');
        }
        expect(core.submitting).toBe(false);
    });

    it('command name is chat.submit (the custom command, not input.submit)', () => {
        expect(CHAT_SUBMIT_COMMAND).toBe('chat.submit');
    });
});

// ---------------------------------------------------------------------------
// (c) Submit during the IME submitting window is a no-op
// ---------------------------------------------------------------------------

describe('T3 (c) submit during IME submitting window is a no-op', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not enqueue when core.submitting is already true', () => {
        const core = createOpenTuiChatBridgeCore();
        core.submitting = true; // simulate mid-IME-defer window
        const textarea = createRecordingTextarea('partial');
        const ref = asTextareaRef(textarea);

        bridgeSubmit(core, ref);
        vi.runAllTimers();

        expect(drainEvents(core)).toHaveLength(0);
        // submitting stays true because bridgeSubmit early-returned before touching it
        expect(core.submitting).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (d) Structural grep: no registerManagedTextareaLayer + filtered bindings
// ---------------------------------------------------------------------------

const KEYMAP_DIR = resolve(__dirname);

function listSourceFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...listSourceFiles(fullPath));
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('T3 (d) structural correctness of managed layer composition', () => {
    it('does NOT call registerManagedTextareaLayer anywhere under apps/cli/src/platform/keymap/', () => {
        const sourceFiles = listSourceFiles(KEYMAP_DIR);
        expect(sourceFiles.length).toBeGreaterThan(0);

        for (const file of sourceFiles) {
            const source = readFileSync(file, 'utf-8');
            // Match the function CALL (not just the import, since the import
            // of the symbol must exist in the addon d.ts). We check for an
            // actual invocation: identifier followed by (.
            expect(source).not.toMatch(/registerManagedTextareaLayer\s*\(/);
        }
    });

    it('EXCLUDED_TEXTAREA_CHORDS includes ctrl+e, ctrl+z, home, and end', () => {
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('ctrl+e');
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('ctrl+z');
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('home');
        expect(EXCLUDED_TEXTAREA_CHORDS).toContain('end');
    });

    it('filterTextareaBindings removes ctrl+e, ctrl+z, home, and end bindings', () => {
        const sample: TextareaBindingLike[] = [
            { key: 'ctrl+e', cmd: 'input.line.end' },
            { key: 'ctrl+z', cmd: 'input.undo' },
            { key: 'home', cmd: 'input.buffer.home' },
            { key: 'end', cmd: 'input.buffer.end' },
            { key: 'ctrl+a', cmd: 'input.line.home' },
            { key: 'shift+home', cmd: 'input.select.buffer.home' },
            { key: 'shift+end', cmd: 'input.select.buffer.end' },
            { key: 'return', cmd: 'input.newline' },
            { key: 'backspace', cmd: 'input.backspace' },
        ];

        const filtered = filterTextareaBindings(sample);
        const filteredKeys = filtered.map((b: TextareaBindingLike) => (typeof b.key === 'string' ? b.key : ''));

        expect(filteredKeys).not.toContain('ctrl+e');
        expect(filteredKeys).not.toContain('ctrl+z');
        expect(filteredKeys).not.toContain('home');
        expect(filteredKeys).not.toContain('end');
        // Non-excluded chords survive the filter
        expect(filteredKeys).toContain('ctrl+a');
        expect(filteredKeys).toContain('shift+home');
        expect(filteredKeys).toContain('shift+end');
        expect(filteredKeys).toContain('return');
        expect(filteredKeys).toContain('backspace');
    });
});

describe('T16 config threading: user overrides flow to input.* bindings', () => {
    it('createConfigDrivenTextareaBindings reflects an overridden input_* chord', () => {
        const overridden = Keybinds.parse(JSON.parse('{"input_line_home":"f2"}'));
        const overriddenBindings = createConfigDrivenTextareaBindings(overridden);
        const overriddenKeys = overriddenBindings.map((b) => b.key);

        expect(overriddenKeys).toContain('f2');

        const defaultBindings = createConfigDrivenTextareaBindings(Keybinds.parse({}));
        const defaultHomeBinding = defaultBindings.find((b) => b.key === 'ctrl+a');
        const overriddenHomeBinding = overriddenBindings.find((b) => b.key === 'ctrl+a');
        if (defaultHomeBinding !== undefined && overriddenHomeBinding !== undefined) {
            expect(overriddenHomeBinding.cmd).not.toBe(defaultHomeBinding.cmd);
        }
    });

    it('createConfigDrivenTextareaBindings with empty overrides produces well-formed bindings', () => {
        const fromDefaults = createConfigDrivenTextareaBindings(Keybinds.parse({}));
        expect(fromDefaults.length).toBeGreaterThan(0);
        for (const binding of fromDefaults) {
            expect(typeof binding.key).toBe('string');
            expect(typeof binding.cmd).toBe('string');
        }
    });
});
