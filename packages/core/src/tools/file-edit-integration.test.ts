import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFileEditTool } from './file-edit.js';
import { prepareExactEdit, throwForFuzzyFailure } from './file-edit-operation.js';
import type { FileEditInput } from './file-edit-schemas.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RELATIVE_PATH = 'src/sample.txt';

function runPrepare(input: FileEditInput, originalContent: string): ReturnType<typeof prepareExactEdit> {
    return prepareExactEdit(input, RELATIVE_PATH, originalContent);
}

function captureError(fn: () => unknown): ToolExecutionError {
    try {
        fn();
        throw new Error('expected prepareExactEdit to throw, but it returned without error');
    } catch (error) {
        if (error instanceof ToolExecutionError) {
            return error;
        }
        throw error;
    }
}

describe('prepareExactEdit fuzzy fallback integration', () => {
    it('applies a unique exact match without invoking the fuzzy fallback', () => {
        const result = runPrepare({ path: RELATIVE_PATH, oldText: 'hello', newText: 'hi' }, 'hello world\n');

        expect(result.updatedContent).toBe('hi world\n');
        expect(result.occurrencesReplaced).toBe(1);
    });

    it('falls back to fuzzy matching when only whitespace differs between oldText and content', () => {
        // Exact matching of 'foo bar baz' against 'foo    bar baz' finds zero matches, so the
        // result can only come from the fuzzy fallback (WhitespaceNormalizedReplacer).
        const result = runPrepare(
            { path: RELATIVE_PATH, oldText: 'foo bar baz', newText: 'replaced' },
            'foo    bar baz\n',
        );

        expect(result.updatedContent).toBe('replaced\n');
        expect(result.occurrencesReplaced).toBe(1);
    });

    it('falls back to fuzzy matching for indentation differences', () => {
        // 'indent me' has no exact match in '    indent me'; the fuzzy fallback matches the
        // indented occurrence and preserves the surrounding whitespace.
        const result = runPrepare({ path: RELATIVE_PATH, oldText: 'indent me', newText: 'done' }, '    indent me\n');

        expect(result.updatedContent).toBe('    done\n');
        expect(result.occurrencesReplaced).toBe(1);
    });

    it('falls back to fuzzy matching for a multi-line indented block', () => {
        const result = runPrepare(
            { path: RELATIVE_PATH, oldText: 'line1\nline2', newText: 'A\nB' },
            '\tline1\n\tline2\n',
        );

        expect(result.updatedContent).toBe('A\nB\n');
        expect(result.occurrencesReplaced).toBe(1);
        expect(result.diffFiles[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
            'removed',
            'removed',
            'added',
            'added',
        ]);
    });

    it('skips the fuzzy fallback when matchStrategy is exact and throws edit_not_found', () => {
        const error = captureError(() =>
            runPrepare(
                { path: RELATIVE_PATH, oldText: 'foo bar baz', newText: 'replaced', matchStrategy: 'exact' },
                'foo    bar baz\n',
            ),
        );

        // The exact-path message proves the fuzzy fallback was skipped; the fuzzy path would
        // have matched 'foo    bar baz' and succeeded instead.
        expect(error.error.message).toContain('edit_not_found');
        expect(error.error.message).toContain('exact text not found');
    });

    it('preserves edit_not_unique when multiple exact matches exist and no selector is set', () => {
        const error = captureError(() =>
            runPrepare({ path: RELATIVE_PATH, oldText: 'foo bar', newText: 'done' }, 'foo bar\nfoo bar\n'),
        );

        expect(error.error.message).toContain('edit_not_unique');
    });

    it('throws edit_not_found when neither exact nor fuzzy matching locates the text', () => {
        const error = captureError(() =>
            runPrepare({ path: RELATIVE_PATH, oldText: 'zzzztotallyabsent', newText: 'x' }, 'hello world\n'),
        );

        expect(error.error.message).toContain('edit_not_found');
    });

    it('still throws edit_not_found when the fuzzy fallback exhausts every replacer', () => {
        // A multi-line oldText whose lines never overlap the content (even trimmed/normalized)
        // forces the fuzzy chain to report not_found.
        const error = captureError(() =>
            runPrepare(
                { path: RELATIVE_PATH, oldText: 'first line here\nsecond line here\nthird line here', newText: 'new' },
                'completely different content\nwith no overlapping text\n',
            ),
        );

        expect(error.error.message).toContain('edit_not_found');
    });
});

describe('throwForFuzzyFailure status mapping', () => {
    // The disproportionate branch is defensive: the fuzzy chain's similarity thresholds keep
    // oversized matches from being yielded, so it is unreachable through prepareExactEdit with
    // realistic input. The mapper is exercised directly to lock the status -> failure-code contract.

    it('maps a disproportionate fuzzy result to edit_not_found', () => {
        const error = captureError(() =>
            throwForFuzzyFailure({ status: 'disproportionate', matchedText: 'overlong matched span' }, RELATIVE_PATH),
        );

        expect(error.error.message).toContain('edit_not_found');
        expect(error.error.message).toContain('disproportionate');
    });

    it('maps a not_unique fuzzy result to edit_not_unique', () => {
        const error = captureError(() => throwForFuzzyFailure({ status: 'not_unique' }, RELATIVE_PATH));

        expect(error.error.message).toContain('edit_not_unique');
    });

    it('maps a not_found fuzzy result to edit_not_found', () => {
        const error = captureError(() => throwForFuzzyFailure({ status: 'not_found' }, RELATIVE_PATH));

        expect(error.error.message).toContain('edit_not_found');
    });
});

describe('file.edit tool end-to-end fuzzy fallback', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('applies a fuzzy-fallback edit through the full approval-gated tool surface', async () => {
        // Exact matching of 'value to replace' against the double-spaced content finds zero
        // matches, so a successful on-disk edit can only come from the fuzzy fallback wired
        // through registerFileEditTool -> prepareExactEdit -> applyFuzzyFallback.
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before  value to replace  after\n');
        const registry = new ToolRegistry();
        await registerFileEditTool(registry, { workspaceRoot, requestPermission: allowPermission });

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'value to replace',
            newText: 'changed',
        });

        expect(result.result.status).toBe('completed');
        expect(await readFile(join(workspaceRoot, 'notes.txt'), 'utf8')).toBe('before  changed  after\n');
        expect(result.structuredOutput).toMatchObject({
            kind: 'file_edit',
            appliedFiles: ['notes.txt'],
            occurrencesReplaced: 1,
        });
    });

    async function createGitWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-edit-fuzzy-'));
        workspaces.push(workspace);
        await execFileAsync('git', ['init'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspace });
        return workspace;
    }

    async function trackedFile(workspaceRoot: string, path: string, content: string): Promise<void> {
        await writeFile(join(workspaceRoot, path), content, 'utf8');
        await execFileAsync('git', ['add', path], { cwd: workspaceRoot });
        await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: workspaceRoot });
    }
});

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

async function invokeEdit(
    registry: ToolRegistry,
    input: { readonly path: string; readonly oldText: string; readonly newText: string },
) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.edit');
    if (advertisement === undefined) {
        throw new TypeError('missing file.edit advertisement');
    }
    return registry.invoke({
        toolCallId: 'edit_call',
        toolName: 'file.edit',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}
