/**
 * Process-level crash guard for the `mc` CLI.
 *
 * WITHOUT this, any promise rejection that escapes its call site (a fire-and-forget
 * `setTimeout`/`void async`, a stream pump, a background timer) becomes an
 * `unhandledRejection`. Node >= 15 terminates the process on the first one by default,
 * and `mc` installed no handler of its own — so the process died instantly and SILENTLY:
 * no log, no core dump, no session status transition. The active session was orphaned at
 * `running` and the user only saw "the process just died".
 *
 * This module converts that silent death into a diagnosable, recoverable failure:
 *   - writes a structured crash record under `<dataDir>/crashes/` (the TUI may swallow
 *     stderr, so a file is the reliable channel),
 *   - records the active interactive session id (registered by the chat loop) so an
 *     orphaned session can be reconciled on the next start,
 *   - exits with code 1 so the process never limps on in an inconsistent state.
 *
 * It is intentionally tiny, synchronous, and re-entrant-safe: a handler must never throw
 * or schedule work that could itself reject while the process is tearing down.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CRASH_DIR_NAME = 'crashes';
export const MAX_KEPT_CRASH_RECORDS = 50;

let installed = false;
let handling = false;
let dataDir: string | undefined;
let activeSessionId: string | undefined;

export type CrashGuardOptions = {
    readonly dataDir: string;
    /** Override for tests; defaults to the real process listeners. */
    readonly installListeners?: (handler: (kind: CrashKind, reason: unknown) => void) => void;
};

export type CrashKind = 'unhandledRejection' | 'uncaughtException';

export type CrashRecord = {
    readonly kind: CrashKind;
    readonly timestamp: string;
    readonly pid: number;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly cwd: string;
    readonly activeSessionId: string | undefined;
    readonly name: string | undefined;
    readonly message: string;
    readonly stack: string | undefined;
};

/**
 * Register the active interactive session id so a crash record names the session that was
 * orphaned. Pass `undefined` when the loop goes idle / between sessions.
 */
export function registerCrashGuardActiveSession(sessionId: string | undefined): void {
    activeSessionId = sessionId;
}

/** Test-only accessor for the currently registered active session id. */
export function crashGuardActiveSession(): string | undefined {
    return activeSessionId;
}

/** Test-only: clear the installed/handling flags so a fresh install can bind new listeners. */
export function resetCrashGuardForTests(): void {
    installed = false;
    handling = false;
    dataDir = undefined;
    activeSessionId = undefined;
}

type GlobalRestoreHost = typeof globalThis & {
    __mcEmergencyTerminalRestore?: () => void;
    __mcFlushPromptDraft?: () => void;
};

/** Best-effort TUI terminal restore via optional global hook (no static tui import). */
function invokeEmergencyTerminalRestore(): void {
    try {
        const host = globalThis as GlobalRestoreHost;
        const restore = host.__mcEmergencyTerminalRestore;
        if (typeof restore === 'function') {
            restore();
        }
    } catch {
        // Crash path must never throw.
    }
}

/** Best-effort flush of the in-flight prompt draft before process exit. */
function invokePromptDraftFlush(): void {
    try {
        const host = globalThis as GlobalRestoreHost;
        const flush = host.__mcFlushPromptDraft;
        if (typeof flush === 'function') {
            flush();
        }
    } catch {
        // Crash path must never throw.
    }
}

export function installCrashGuard(options: CrashGuardOptions): void {
    if (installed) return;
    installed = true;
    dataDir = options.dataDir;
    const install = options.installListeners ?? installRealListeners;
    install(handleFatal);
}

function installRealListeners(handler: (kind: CrashKind, reason: unknown) => void): void {
    process.on('unhandledRejection', (reason) => handler('unhandledRejection', reason));
    process.on('uncaughtException', (error) => handler('uncaughtException', error));
}

function handleFatal(kind: CrashKind, reason: unknown): void {
    if (handling) return;
    handling = true;
    // Flush any in-flight prompt draft, then restore terminal modes before
    // diagnostics so a crashed interactive TUI does not leave the parent shell
    // unusable and the operator does not lose the half-typed prompt.
    invokePromptDraftFlush();
    invokeEmergencyTerminalRestore();
    const record = buildCrashRecord(kind, reason);
    writeCrashRecord(record);
    // Best-effort stderr mirror; the TUI may swallow this but non-TUI runs benefit.
    try {
        process.stderr.write(formatCrashRecord(record));
    } catch {
        // ignore
    }
    // No return path: a coding-agent process that lost an async subsystem is in an
    // inconsistent state. Exit so the next start reconciles the orphaned session.
    process.exit(1);
}

function buildCrashRecord(kind: CrashKind, reason: unknown): CrashRecord {
    const error = reason as { name?: string; message?: string; stack?: string } | undefined;
    const message =
        typeof reason === 'object' && reason !== null && typeof error?.message === 'string'
            ? error.message
            : typeof reason === 'string'
              ? reason
              : String(reason ?? '');
    return {
        kind,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd(),
        activeSessionId,
        name: typeof error?.name === 'string' ? error.name : undefined,
        message,
        stack: typeof error?.stack === 'string' ? error.stack : undefined,
    };
}

function writeCrashRecord(record: CrashRecord): void {
    try {
        const dir = join(dataDir ?? '.', CRASH_DIR_NAME);
        mkdirSync(dir, { recursive: true });
        const stamp = record.timestamp.replace(/[^0-9T-Za-z]+/gu, '-').replace(/:/gu, '');
        const path = join(dir, `${stamp}-${record.kind}.log`);
        writeFileSync(path, formatCrashRecord(record), { encoding: 'utf8', flag: 'wx' });
        pruneOldCrashRecords(dir);
    } catch {
        // A crash handler must never throw; the file is best-effort diagnostics.
    }
}

function pruneOldCrashRecords(dir: string): void {
    try {
        const entries = readdirSync(dir)
            .map((name) => {
                const path = join(dir, name);
                try {
                    return { name, path, mtimeMs: statSync(path).mtimeMs };
                } catch {
                    return undefined;
                }
            })
            .filter((entry): entry is { name: string; path: string; mtimeMs: number } => entry !== undefined)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const entry of entries.slice(MAX_KEPT_CRASH_RECORDS)) {
            try {
                unlinkSync(entry.path);
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }
}

export function formatCrashRecord(record: CrashRecord): string {
    const lines = [
        `mission-control crash: ${record.kind}`,
        `timestamp: ${record.timestamp}`,
        `pid: ${record.pid}`,
        `node: ${record.nodeVersion}`,
        `platform: ${record.platform}`,
        `cwd: ${record.cwd}`,
        `session: ${record.activeSessionId ?? '(none)'}`,
        `error: ${record.name ?? 'Error'}: ${record.message}`,
    ];
    if (record.stack !== undefined) {
        lines.push('--- stack ---');
        lines.push(record.stack);
    }
    lines.push('--- json ---');
    lines.push(JSON.stringify(record));
    lines.push('');
    return lines.join('\n');
}
