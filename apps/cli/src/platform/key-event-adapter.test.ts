import { describe, expect, it } from 'vitest';
import {
    adaptKeyEvent,
    createKeyEventAdapter,
    type OpenTuiKeyInput,
} from './key-event-adapter.js';

/** Minimal opentui KeyEvent-shaped fixture (only the fields the adapter reads). */
function key(name: string, overrides: Partial<OpenTuiKeyInput> = {}): OpenTuiKeyInput {
    return { name, sequence: name, ...overrides };
}

describe('adaptKeyEvent', () => {
    it('translates a printable letter to { input: <char>, key: all-false }', () => {
        const result = adaptKeyEvent(key('h', { sequence: 'h' }));
        expect(result.input).toBe('h');
        expect(result.key.upArrow).toBe(false);
        expect(result.key.ctrl).toBe(false);
        expect(result.key.return).toBe(false);
    });

    it('translates Return to { input: "\\r", key.return: true }', () => {
        const result = adaptKeyEvent(key('return', { sequence: '\r' }));
        expect(result.input).toBe('\r');
        expect(result.key.return).toBe(true);
    });

    it('translates an arrow to { input: "", key.upArrow: true }', () => {
        const result = adaptKeyEvent(key('up', { sequence: '\u001b[A' }));
        expect(result.input).toBe('');
        expect(result.key.upArrow).toBe(true);
        expect(result.key.downArrow).toBe(false);
    });

    it('translates Ctrl+C to { input: "c", key.ctrl: true } (Ink delivers the letter, not \\x03)', () => {
        // Ink's useInput sets `input = keypress.name` for ctrl-held keypresses,
        // and handleInput checks `key.ctrl && input === 'c'`. Delivering "\x03"
        // would break the Ctrl+C interrupt path.
        const result = adaptKeyEvent(key('c', { ctrl: true, sequence: '\x03' }));
        expect(result.input).toBe('c');
        expect(result.key.ctrl).toBe(true);
    });

    it('translates Ctrl+G to { input: "g", key.ctrl: true }', () => {
        const result = adaptKeyEvent(key('g', { ctrl: true, sequence: '\x07' }));
        expect(result.input).toBe('g');
        expect(result.key.ctrl).toBe(true);
    });

    it('translates Backspace to { input: "", key.backspace: true } (Ink suppresses via nonAlphanumericKeys)', () => {
        // handleInput only inspects `key.backspace`, so input='' (Ink-faithful)
        // is safe; the bridge never reads `input` on the backspace branch.
        const result = adaptKeyEvent(key('backspace', { sequence: '\x7f' }));
        expect(result.key.backspace).toBe(true);
        expect(result.input).toBe('');
    });

    it('translates Tab to { input: "", key.tab: true } (Ink suppresses via nonAlphanumericKeys)', () => {
        const result = adaptKeyEvent(key('tab', { sequence: '\t' }));
        expect(result.key.tab).toBe(true);
        expect(result.input).toBe('');
    });

    it('translates Escape to { input: "", key.escape: true } (leading ESC stripped)', () => {
        const result = adaptKeyEvent(key('escape', { sequence: '\x1b' }));
        expect(result.key.escape).toBe(true);
        expect(result.input).toBe('');
    });

    it('translates Space to { input: " ", key: all-false }', () => {
        const result = adaptKeyEvent(key('space', { sequence: ' ' }));
        expect(result.input).toBe(' ');
        expect(result.key.return).toBe(false);
        expect(result.key.ctrl).toBe(false);
    });

    it('translates pageup/pagedown/home/end/delete flags and suppresses input', () => {
        expect(adaptKeyEvent(key('pageup', { sequence: '\u001b[5~' }))).toMatchObject({
            input: '',
            key: { pageUp: true },
        });
        expect(adaptKeyEvent(key('pagedown', { sequence: '\u001b[6~' }))).toMatchObject({
            input: '',
            key: { pageDown: true },
        });
        expect(adaptKeyEvent(key('home', { sequence: '\u001b[H' }))).toMatchObject({
            input: '',
            key: { home: true },
        });
        expect(adaptKeyEvent(key('end', { sequence: '\u001b[F' }))).toMatchObject({
            input: '',
            key: { end: true },
        });
        expect(adaptKeyEvent(key('delete', { sequence: '\u001b[3~' }))).toMatchObject({
            input: '',
            key: { delete: true },
        });
    });

    it('forwards modifier flags (shift, meta, super) from the opentui event', () => {
        const result = adaptKeyEvent(key('x', { shift: true, meta: true, super: true }));
        expect(result.key.shift).toBe(true);
        expect(result.key.meta).toBe(true);
        expect(result.key.super).toBe(true);
        expect(result.input).toBe('x');
    });

    it('produces a full InkKeyShape with all 20 boolean fields defined', () => {
        const result = adaptKeyEvent(key('a'));
        expect(Object.keys(result.key).sort()).toEqual(
            [
                'backspace',
                'capsLock',
                'ctrl',
                'delete',
                'downArrow',
                'end',
                'escape',
                'hyper',
                'home',
                'leftArrow',
                'meta',
                'numLock',
                'pageDown',
                'pageUp',
                'return',
                'rightArrow',
                'shift',
                'super',
                'tab',
                'upArrow',
            ].sort(),
        );
    });
});

describe('createKeyEventAdapter', () => {
    it('consume() delegates to adaptKeyEvent (stateless per-event translation)', () => {
        const adapter = createKeyEventAdapter();
        expect(adapter.consume(key('h', { sequence: 'h' })).input).toBe('h');
        expect(adapter.consume(key('return', { sequence: '\r' })).key.return).toBe(true);
        expect(adapter.consume(key('c', { ctrl: true, sequence: '\x03' }))).toMatchObject({
            input: 'c',
            key: { ctrl: true },
        });
    });
});
