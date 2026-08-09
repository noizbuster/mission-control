/**
 * Crash-safe terminal restore for the OpenTUI interactive path.
 *
 * Ported from ref/omp `emergencyTerminalRestore`: when a process-level crash
 * handler fires after the TUI has entered raw mode / mouse tracking / alt
 * screen, the parent shell must not inherit a corrupted terminal. Sequences are
 * best-effort and never throw.
 *
 * DECRST 1049 (leave alternate screen) is gated on tracked alt-screen state.
 * Windows conhost/WT run an unconditional cursor restore for that sequence even
 * when the alt buffer was never entered, which homes the cursor and drops the
 * shell prompt on top of the dead frame.
 */

const GLOBAL_RESTORE_KEY = '__mcEmergencyTerminalRestore';

type GlobalRestoreHost = typeof globalThis & {
    __mcEmergencyTerminalRestore?: () => void;
};

let altScreenActive = false;
let terminalSessionActive = false;

/** Record whether a fullscreen/alt-screen overlay currently owns the alt buffer. */
export function setAltScreenActive(active: boolean): void {
    altScreenActive = active;
}

/** Test/read helper for the tracked alt-screen flag. */
export function isAltScreenActive(): boolean {
    return altScreenActive;
}

/**
 * Mark that an interactive TUI session has started (or ended). Blind restore
 * only runs when a session was known to have started — non-TUI CLI paths must
 * never emit terminal escape noise.
 */
export function setTerminalSessionActive(active: boolean): void {
    terminalSessionActive = active;
    if (!active) {
        altScreenActive = false;
    }
}

/** Test/read helper for the session-active flag. */
export function isTerminalSessionActive(): boolean {
    return terminalSessionActive;
}

/**
 * Publish the restore hook on globalThis so the CLI crash-guard can call it
 * without a static apps/tui import (keeps `--json`/`--no-tui` free of OpenTUI).
 */
export function registerEmergencyTerminalRestoreGlobal(): void {
    const host = globalThis as GlobalRestoreHost;
    host[GLOBAL_RESTORE_KEY] = emergencyTerminalRestore;
}

/** Clear the global restore hook on clean unmount. */
export function unregisterEmergencyTerminalRestoreGlobal(): void {
    const host = globalThis as GlobalRestoreHost;
    if (host[GLOBAL_RESTORE_KEY] === emergencyTerminalRestore) {
        Reflect.deleteProperty(host, GLOBAL_RESTORE_KEY);
    }
}

/** Reset module flags between tests. */
export function resetEmergencyTerminalRestoreForTests(): void {
    altScreenActive = false;
    terminalSessionActive = false;
    unregisterEmergencyTerminalRestoreGlobal();
}

/**
 * Best-effort restore of terminal modes after a crash or hard exit.
 * Safe to call multiple times; never throws.
 */
export function emergencyTerminalRestore(): void {
    if (!terminalSessionActive && !altScreenActive) {
        return;
    }

    try {
        const leaveAlt = altScreenActive ? '\x1b[?1049l' : '';
        // Order mirrors omp: end sync output, restore autowrap, disable paste /
        // mouse / kitty keyboard, optionally leave alt screen, show cursor.
        process.stdout.write(
            '\x1b[?2026l' + // End synchronized output
                '\x1b[?7h' + // Restore autowrap
                '\x1b[?2004l' + // Disable bracketed paste
                '\x1b[?1006l\x1b[?1003l\x1b[?1000l' + // Disable mouse tracking
                '\x1b[<u' + // Pop kitty keyboard protocol
                leaveAlt +
                '\x1b[?25h', // Show cursor
        );
    } catch {
        // stdout may already be dead during crash cleanup.
    }

    try {
        if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY === true) {
            process.stdin.setRawMode(false);
        }
    } catch {
        // ignore
    }

    altScreenActive = false;
    terminalSessionActive = false;
}
