import { describe, expect, it } from 'vitest';
import {
    assertNotepadWriteAllowed,
    isNotepadPath,
    NotepadGuardError,
    type NotepadGuardErrorCode,
    type NotepadGuardInput,
} from './notepad-guard.js';
import { join } from 'node:path';

const WORKSPACE = '/test-workspace';

function notepadsTarget(relative: string): string {
    return join(WORKSPACE, '.omo', 'notepads', relative);
}

function guardInput(
    targetPath: string,
    operation: NotepadGuardInput['operation'],
    workspaceRoot: string = WORKSPACE,
): NotepadGuardInput {
    return { targetPath, operation, workspaceRoot };
}

/**
 * Capture the thrown {@link NotepadGuardError} from a guard call so we can assert
 * on its `code`/`path` fields without `as` casts. Throws in the test when the
 * guard does not throw, surfacing the failure clearly.
 */
function captureGuardError(input: NotepadGuardInput): NotepadGuardError {
    try {
        assertNotepadWriteAllowed(input);
    } catch (error: unknown) {
        if (error instanceof NotepadGuardError) {
            return error;
        }
        throw error;
    }
    throw new Error(`Expected assertNotepadWriteAllowed to throw for ${JSON.stringify(input)}`);
}

describe('isNotepadPath', () => {
    it('returns true for a file under .omo/notepads/ in the workspace', () => {
        // Given
        const target = notepadsTarget('demo-plan/learnings.md');

        // When
        const result = isNotepadPath(target, WORKSPACE);

        // Then
        expect(result).toBe(true);
    });

    it('returns true for a relative path that resolves into .omo/notepads/', () => {
        // Given
        const target = '.omo/notepads/demo-plan/learnings.md';

        // When
        const result = isNotepadPath(target, WORKSPACE);

        // Then
        expect(result).toBe(true);
    });

    it('returns false for a file outside .omo/notepads/', () => {
        // Given / When / Then
        expect(isNotepadPath('/tmp/foo.txt', WORKSPACE)).toBe(false);
        expect(isNotepadPath(join(WORKSPACE, 'src', 'index.ts'), WORKSPACE)).toBe(false);
        expect(isNotepadPath(join(WORKSPACE, '.omo', 'boulder.json'), WORKSPACE)).toBe(false);
    });

    it('returns false for an unrelated absolute path that does not contain the segment pair', () => {
        // Given / When
        const result = isNotepadPath('/var/log/app.log', WORKSPACE);

        // Then
        expect(result).toBe(false);
    });
});

describe('assertNotepadWriteAllowed — append operations', () => {
    it('allows append operations targeting a notepad file', () => {
        // Given
        const input = guardInput(notepadsTarget('demo-plan/learnings.md'), 'append');

        // When / Then
        expect(() => assertNotepadWriteAllowed(input)).not.toThrow();
    });

    it('allows append operations via a relative path that resolves into notepads', () => {
        // Given
        const input = guardInput('.omo/notepads/demo-plan/decisions.md', 'append');

        // When / Then
        expect(() => assertNotepadWriteAllowed(input)).not.toThrow();
    });
});

describe('assertNotepadWriteAllowed — non-append operations rejected', () => {
    it.each<NotepadGuardInput['operation']>([
        'truncate',
        'overwrite',
        'delete',
    ])('rejects %s on a notepad path with notepad_guard_non_append', (operation) => {
        // Given
        const target = notepadsTarget('demo-plan/learnings.md');

        // When
        const error = captureGuardError(guardInput(target, operation));

        // Then
        expect(error).toBeInstanceOf(NotepadGuardError);
        expect(error.code).toBe<NotepadGuardErrorCode>('notepad_guard_non_append');
        expect(error.path).toBe(target);
    });

    it('includes the offending operation kind in the error message', () => {
        // Given
        const target = notepadsTarget('demo-plan/issues.md');

        // When
        const error = captureGuardError(guardInput(target, 'overwrite'));

        // Then
        expect(error.message).toContain('overwrite');
    });
});

describe('assertNotepadWriteAllowed — path traversal blocked', () => {
    it('rejects an append that contains a `..` traversal segment', () => {
        // Given — raw path touches notepads but tries to climb out of it.
        const target = `${WORKSPACE}/.omo/notepads/demo-plan/../../../etc/passwd`;

        // When
        const error = captureGuardError(guardInput(target, 'append'));

        // Then
        expect(error.code).toBe<NotepadGuardErrorCode>('notepad_guard_path_traversal');
        expect(error.path).toBe(target);
    });

    it('reports traversal even when the operation is also non-append (traversal wins)', () => {
        // Given
        const target = `${WORKSPACE}/.omo/notepads/../../boulder.json`;

        // When
        const error = captureGuardError(guardInput(target, 'truncate'));

        // Then
        expect(error.code).toBe<NotepadGuardErrorCode>('notepad_guard_path_traversal');
    });

    it('rejects a relative path with a leading `..` that touches notepads', () => {
        // Given
        const target = '../workspace/.omo/notepads/demo-plan/learnings.md';

        // When
        const error = captureGuardError(guardInput(target, 'append'));

        // Then
        expect(error.code).toBe<NotepadGuardErrorCode>('notepad_guard_path_traversal');
    });
});

describe('assertNotepadWriteAllowed — guard does not apply outside notepads', () => {
    it.each<NotepadGuardInput['operation']>([
        'truncate',
        'overwrite',
        'delete',
    ])('does NOT throw when %s targets a path outside .omo/notepads/', (operation) => {
        // Given
        const input = guardInput('/tmp/not-a-notepad.txt', operation);

        // When / Then
        expect(() => assertNotepadWriteAllowed(input)).not.toThrow();
    });

    it('does not throw for a non-append on a sibling .omo file', () => {
        // Given — boulder.json lives under .omo/ but NOT under .omo/notepads/.
        const input = guardInput(join(WORKSPACE, '.omo', 'boulder.json'), 'overwrite');

        // When / Then
        expect(() => assertNotepadWriteAllowed(input)).not.toThrow();
    });

    it('does not throw for a path that normalizes out of notepads without raw traversal segments', () => {
        // Given — absolute path under another workspace's tree; no raw notepads segment.
        const input = guardInput('/other/workspace/src/index.ts', 'overwrite');

        // When / Then
        expect(() => assertNotepadWriteAllowed(input)).not.toThrow();
    });
});

describe('assertNotepadWriteAllowed — workspace root validation', () => {
    it('throws when workspaceRoot is empty', () => {
        // Given
        const input: NotepadGuardInput = {
            targetPath: notepadsTarget('demo-plan/learnings.md'),
            operation: 'append',
            workspaceRoot: '',
        };

        // When
        const error = captureGuardError(input);

        // Then
        expect(error.code).toBe<NotepadGuardErrorCode>('notepad_guard_unsafe_workspace_root');
    });
});
