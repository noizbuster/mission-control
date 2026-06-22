import { OmoPersistenceError } from '../../persistence/paths.js';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

const OMO_DIR_NAME = '.omo';
const NOTEPADS_DIR_NAME = 'notepads';

/**
 * Write operations a tool might perform. Only {@link NotepadWriteOperationAppend}
 * is permitted inside `.omo/notepads/`; everything else is rejected by the guard.
 */
export type NotepadWriteOperation = NotepadWriteOperationAppend | NotepadWriteOperationForbidden;

export type NotepadWriteOperationAppend = 'append';

export type NotepadWriteOperationForbidden = 'truncate' | 'overwrite' | 'delete';

export type NotepadGuardErrorCode =
    | 'notepad_guard_non_append'
    | 'notepad_guard_path_traversal'
    | 'notepad_guard_unsafe_workspace_root';

export type NotepadGuardInput = {
    readonly targetPath: string;
    readonly operation: NotepadWriteOperation;
    readonly workspaceRoot: string;
};

const APPEND_OPERATIONS: ReadonlySet<NotepadWriteOperation> = new Set<NotepadWriteOperation>(['append']);

export class NotepadGuardError extends OmoPersistenceError {
    constructor(message: string, code: NotepadGuardErrorCode, path?: string) {
        super(message, code, path);
        this.name = 'NotepadGuardError';
    }
}

/**
 * Returns true when `targetPath` resolves under `<workspaceRoot>/.omo/notepads/`,
 * OR when the raw path string contains a `.omo/notepads` segment pair (which catches
 * traversal attempts that would otherwise normalize away). Pure (no I/O).
 */
export function isNotepadPath(targetPath: string, workspaceRoot: string): boolean {
    return pathTouchesNotepads(targetPath, workspaceRoot);
}

/**
 * Throw {@link NotepadGuardError} when a write targets `.omo/notepads/` and is not
 * an append-class operation, or when the raw path contains `..` traversal segments.
 * Pure (no I/O). Tools call this immediately before performing a write so the guard
 * can gate the effect.
 *
 * Order of checks (matters): traversal is reported before operation kind so the
 * more severe attack is surfaced first even when both apply.
 */
export function assertNotepadWriteAllowed(input: NotepadGuardInput): void {
    const { targetPath, operation, workspaceRoot } = input;
    if (workspaceRoot.length === 0) {
        throw new NotepadGuardError(
            'Refusing notepad guard check: workspaceRoot must be a non-empty path',
            'notepad_guard_unsafe_workspace_root',
            targetPath,
        );
    }
    if (!pathTouchesNotepads(targetPath, workspaceRoot)) {
        return;
    }
    if (containsTraversalSegments(targetPath)) {
        throw new NotepadGuardError(
            `Refusing notepad write: path traversal segment ('..') detected in ${JSON.stringify(targetPath)}`,
            'notepad_guard_path_traversal',
            targetPath,
        );
    }
    if (!APPEND_OPERATIONS.has(operation)) {
        throw new NotepadGuardError(
            `Refusing notepad write: only append operations are permitted under .omo/notepads/ (got ${JSON.stringify(operation)})`,
            'notepad_guard_non_append',
            targetPath,
        );
    }
}

function pathTouchesNotepads(targetPath: string, workspaceRoot: string): boolean {
    if (rawPathContainsNotepadsSegments(targetPath)) {
        return true;
    }
    const resolved = resolveAbsolutePath(targetPath, workspaceRoot);
    const notepadsRoot = resolve(workspaceRoot, OMO_DIR_NAME, NOTEPADS_DIR_NAME);
    return pathContains(notepadsRoot, resolved);
}

function resolveAbsolutePath(targetPath: string, workspaceRoot: string): string {
    return isAbsolute(targetPath) ? normalize(targetPath) : resolve(workspaceRoot, targetPath);
}

function rawPathContainsNotepadsSegments(path: string): boolean {
    const segments = splitPathSegments(path);
    for (let i = 0; i < segments.length - 1; i += 1) {
        if (segments[i] === OMO_DIR_NAME && segments[i + 1] === NOTEPADS_DIR_NAME) {
            return true;
        }
    }
    return false;
}

function containsTraversalSegments(path: string): boolean {
    return splitPathSegments(path).some((segment) => segment === '..');
}

function splitPathSegments(path: string): readonly string[] {
    return path.split(/[\\/]/u);
}

function pathContains(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
