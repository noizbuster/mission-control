/**
 * Crash-resilient in-flight prompt draft persistence.
 *
 * Manual prompt stash (`PromptStash`) is an explicit LIFO operator tool.
 * This module is the automatic path: debounced writes of the live inputMirror
 * keyed by session id under `<dataDir>/prompt-drafts/`, plus a sync flush hook
 * the CLI crash-guard can invoke without importing TUI internals.
 *
 * Fail-closed: all I/O is best-effort and never throws to callers.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROMPT_DRAFT_DIR_NAME = 'prompt-drafts';
export const PROMPT_DRAFT_MAX_CHARS = 64_000;
export const PROMPT_DRAFT_DEBOUNCE_MS = 250;

export type PromptDraftRecord = {
    readonly version: 1;
    readonly sessionId: string;
    readonly text: string;
    readonly updatedAt: string;
};

type GlobalDraftHost = typeof globalThis & {
    __mcFlushPromptDraft?: () => void;
};

const GLOBAL_FLUSH_KEY = '__mcFlushPromptDraft' as const;

let activeDataDir: string | undefined;
let activeSessionId: string | undefined;
let activeText = '';
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function promptDraftPath(dataDir: string, sessionId: string): string {
    const safe = sanitizeSessionId(sessionId);
    return join(dataDir, PROMPT_DRAFT_DIR_NAME, `${safe}.json`);
}

export function sanitizeSessionId(sessionId: string): string {
    const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 120);
    return cleaned.length > 0 ? cleaned : 'unknown';
}

export function clampDraftText(text: string): string {
    if (text.length <= PROMPT_DRAFT_MAX_CHARS) return text;
    return text.slice(0, PROMPT_DRAFT_MAX_CHARS);
}

/** Register the process-global sync flush used by the CLI crash-guard. */
export function registerPromptDraftFlushGlobal(): void {
    const host = globalThis as GlobalDraftHost;
    host[GLOBAL_FLUSH_KEY] = flushPromptDraftSync;
}

export function unregisterPromptDraftFlushGlobal(): void {
    const host = globalThis as GlobalDraftHost;
    if (host[GLOBAL_FLUSH_KEY] === flushPromptDraftSync) {
        Reflect.deleteProperty(host, GLOBAL_FLUSH_KEY);
    }
}

export function resetPromptDraftForTests(): void {
    if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    activeDataDir = undefined;
    activeSessionId = undefined;
    activeText = '';
    unregisterPromptDraftFlushGlobal();
}

/**
 * Update the live draft mirror. Empty text schedules deletion. Non-empty text
 * is debounced to disk. Call on every inputMirror / sessionId change.
 */
export function notePromptDraft(input: {
    readonly dataDir: string | undefined;
    readonly sessionId: string | undefined;
    readonly text: string;
}): void {
    activeDataDir = input.dataDir;
    activeSessionId = input.sessionId;
    activeText = clampDraftText(input.text);
    if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    if (activeDataDir === undefined || activeSessionId === undefined || activeSessionId.length === 0) {
        return;
    }
    // Empty/whitespace drafts clear immediately so a successful submit cannot be
    // resurrected by a crash inside the debounce window.
    if (activeText.trim().length === 0) {
        flushPromptDraftSync();
        return;
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        flushPromptDraftSync();
    }, PROMPT_DRAFT_DEBOUNCE_MS);
}

/** Synchronously persist or clear the active draft. Safe on the crash path. */
export function flushPromptDraftSync(): void {
    if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    const dataDir = activeDataDir;
    const sessionId = activeSessionId;
    if (dataDir === undefined || sessionId === undefined || sessionId.length === 0) return;
    const path = promptDraftPath(dataDir, sessionId);
    try {
        if (activeText.trim().length === 0) {
            try {
                unlinkSync(path);
            } catch {
                // missing is fine
            }
            return;
        }
        mkdirSync(join(dataDir, PROMPT_DRAFT_DIR_NAME), { recursive: true });
        const record: PromptDraftRecord = {
            version: 1,
            sessionId,
            text: activeText,
            updatedAt: new Date().toISOString(),
        };
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8');
        renameSync(tmp, path);
    } catch {
        // crash / disk path must never throw
    }
}

/** Read a draft for restore. Returns undefined when missing/invalid/empty. */
export function readPromptDraft(
    dataDir: string,
    sessionId: string,
): PromptDraftRecord | undefined {
    if (sessionId.length === 0) return undefined;
    try {
        const raw = readFileSync(promptDraftPath(dataDir, sessionId), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const record = parsed as {
            version?: unknown;
            sessionId?: unknown;
            text?: unknown;
            updatedAt?: unknown;
        };
        if (record.version !== 1) return undefined;
        if (typeof record.sessionId !== 'string' || record.sessionId !== sessionId) return undefined;
        if (typeof record.text !== 'string') return undefined;
        const text = clampDraftText(record.text);
        if (text.trim().length === 0) return undefined;
        return {
            version: 1,
            sessionId: record.sessionId,
            text,
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        };
    } catch {
        return undefined;
    }
}

export function clearPromptDraft(dataDir: string, sessionId: string): void {
    if (sessionId.length === 0) return;
    try {
        unlinkSync(promptDraftPath(dataDir, sessionId));
    } catch {
        // ignore
    }
    if (activeSessionId === sessionId) {
        activeText = '';
    }
}
