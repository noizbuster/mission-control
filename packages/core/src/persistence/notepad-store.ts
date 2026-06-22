import { OmoPersistenceError } from './paths.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const NOTEPADS_DIR = 'notepads';

export const NOTEPAD_FILES = ['learnings', 'decisions', 'issues', 'problems'] as const;
export type NotepadFile = (typeof NOTEPAD_FILES)[number];

export type NotepadAppendOptions = {
    readonly now?: () => Date;
    readonly root?: string;
};

export class NotepadAppendOnlyError extends OmoPersistenceError {
    constructor(message: string, path?: string, cause?: unknown) {
        super(message, 'notepad_truncation_rejected', path, cause !== undefined ? { cause } : undefined);
        this.name = 'NotepadAppendOnlyError';
    }
}

export class NotepadStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'NotepadStoreError';
    }
}

/**
 * Pure guard: throws `NotepadAppendOnlyError` when `next` would NOT preserve all
 * of `existing` (i.e. when `next` is not a byte-for-byte superset prefix of
 * `existing`). This is the core of the append-only contract and is unit-tested
 * in isolation.
 */
export function assertAppendOnly(existing: string, next: string): void {
    if (next.length < existing.length) {
        throw new NotepadAppendOnlyError('Notepad write rejected: proposed content is shorter than existing content');
    }
    if (!next.startsWith(existing)) {
        throw new NotepadAppendOnlyError(
            'Notepad write rejected: proposed content does not preserve the existing prefix',
        );
    }
}

/**
 * Append a timestamped entry to `.omo/notepads/{planName}/{file}.md`.
 *
 * The write is append-only: existing content is read, the new content is
 * validated by `assertAppendOnly`, and the result is written atomically via a
 * temp-file-then-rename. Any write that would truncate the file throws
 * `NotepadAppendOnlyError`.
 *
 * `planName` must be a safe path segment; `file` must be one of the canonical
 * notepad file names (`learnings`, `decisions`, `issues`, `problems`).
 */
export async function appendNotepad(
    planName: string,
    file: NotepadFile,
    entry: string,
    options: NotepadAppendOptions = {},
): Promise<void> {
    assertSafePlanName(planName);
    assertNotepadFile(file);
    const root = options.root;
    if (root === undefined) {
        throw new NotepadStoreError(
            'appendNotepad requires an explicit .omo root via options.root',
            'notepad_root_required',
        );
    }
    const filePath = notepadFilePath(root, planName, file);
    const stamp = (options.now ?? (() => new Date()))().toISOString();
    const block = buildAppendBlock(stamp, entry);

    const existing = await readExistingForAppend(filePath);
    const next = existing + block;
    assertAppendOnly(existing, next);
    await atomicWrite(filePath, next);
}

export function notepadFilePath(root: string, planName: string, file: NotepadFile): string {
    return join(root, '.omo', NOTEPADS_DIR, planName, `${file}.md`);
}

/**
 * Read the current notepad content for append purposes. Returns an empty string
 * when the file does not exist yet (the first append creates it). Throws on any
 * other read failure.
 */
export async function readNotepad(root: string, planName: string, file: NotepadFile): Promise<string> {
    assertSafePlanName(planName);
    assertNotepadFile(file);
    return readExistingForAppend(notepadFilePath(root, planName, file));
}

function buildAppendBlock(stamp: string, entry: string): string {
    const trimmedEntry = entry.replace(/\s+$/u, '');
    const leadingNewline = trimmedEntry.length > 0 && !trimmedEntry.startsWith('\n') ? '\n' : '';
    return `${leadingNewline}<!-- appended ${stamp} -->\n${trimmedEntry}\n`;
}

async function readExistingForAppend(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return '';
        }
        throw new NotepadStoreError(`Failed to read notepad at ${filePath}`, 'notepad_read_failed', filePath, error);
    }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
    await rm(tempPath, { force: true });
}

function assertSafePlanName(planName: string): void {
    if (!/^[A-Za-z0-9._-]+$/u.test(planName)) {
        throw new NotepadStoreError(
            `Refusing notepad write for unsafe plan name ${JSON.stringify(planName)}`,
            'notepad_unsafe_plan_name',
        );
    }
}

function assertNotepadFile(file: string): asserts file is NotepadFile {
    if (!NOTEPAD_FILES.includes(file as NotepadFile)) {
        throw new NotepadStoreError(
            `Unknown notepad file ${JSON.stringify(file)}; expected one of ${NOTEPAD_FILES.join(', ')}`,
            'notepad_unknown_file',
        );
    }
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
