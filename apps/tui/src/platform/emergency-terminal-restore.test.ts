import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    emergencyTerminalRestore,
    isAltScreenActive,
    resetEmergencyTerminalRestoreForTests,
    setAltScreenActive,
    setTerminalSessionActive,
} from './emergency-terminal-restore';

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(target, key, descriptor);
        return;
    }
    Reflect.deleteProperty(target, key);
}

afterEach(() => {
    resetEmergencyTerminalRestoreForTests();
    vi.restoreAllMocks();
    restoreProperty(process.stdin, 'isTTY', stdinIsTtyDescriptor);
    restoreProperty(process.stdin, 'setRawMode', stdinSetRawModeDescriptor);
});

describe('emergencyTerminalRestore', () => {
    it('is a no-op when no TUI session was started', () => {
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
            return true;
        });

        emergencyTerminalRestore();
        expect(writes).toEqual([]);
    });

    it('restores modes without leaving alt screen when alt was never entered', () => {
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
            return true;
        });
        const setRawMode = vi.fn();
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdin, 'setRawMode', { value: setRawMode, configurable: true });

        setTerminalSessionActive(true);
        emergencyTerminalRestore();

        const restored = writes.join('');
        expect(restored).toContain('\x1b[?25h');
        expect(restored).toContain('\x1b[?2004l');
        expect(restored).not.toContain('\x1b[?1049l');
        expect(setRawMode).toHaveBeenCalledWith(false);
        expect(isAltScreenActive()).toBe(false);
    });

    it('emits leave-alt only while alt screen is tracked active, then clears state', () => {
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
            return true;
        });

        setTerminalSessionActive(true);
        setAltScreenActive(true);
        emergencyTerminalRestore();
        expect(writes.join('')).toContain('\x1b[?1049l');
        expect(isAltScreenActive()).toBe(false);

        writes.length = 0;
        emergencyTerminalRestore();
        expect(writes).toEqual([]);
    });
});
