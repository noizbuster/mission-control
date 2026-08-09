import { resolveMissionControlDataDir } from '@mission-control/core';
import { atomicTextWrite } from './atomic-text-write';
import { type ApprovalLevel, isApprovalLevel } from '@mission-control/tui/state';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const APPROVAL_LEVEL_FILENAME = 'approval-level.json';

type StoredApprovalLevel = { readonly level: ApprovalLevel };

/** Process-local chain so concurrent approval persists cannot interleave. */
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = writeChain.then(task, task);
    writeChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/**
 * Persisted global approval level. The level is loaded once at chat startup
 * and saved whenever the user changes it via `/approval <level>` or the
 * `/approval` picker overlay. Returns `undefined` when no level has been
 * persisted yet, when the file is missing/malformed, or when the stored value
 * is not a known {@link ApprovalLevel}.
 */
export async function loadPersistedApprovalLevel(): Promise<ApprovalLevel | undefined> {
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, APPROVAL_LEVEL_FILENAME);
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { level?: unknown }).level === 'string'
        ) {
            const candidate = (parsed as { level: string }).level;
            if (isApprovalLevel(candidate)) {
                return candidate;
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Persist the given approval level so the next chat session reuses it.
 * Uses canonical temp-file-then-rename atomic write.
 */
export async function savePersistedApprovalLevel(level: ApprovalLevel): Promise<void> {
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, APPROVAL_LEVEL_FILENAME);
    const payload: StoredApprovalLevel = { level };
    await enqueueWrite(async () => {
        await atomicTextWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    });
}
