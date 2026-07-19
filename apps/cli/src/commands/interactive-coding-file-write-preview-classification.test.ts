import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildFileWritePreview,
    parseFileWritePreviewValue,
    renderFileWritePreview,
} from './interactive-coding-file-write-preview';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const openMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises')['open']>());

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: openMock };
});

const tempRoots: string[] = [];

describe('file.write preview target classification', () => {
    afterEach(async () => {
        openMock.mockReset();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('blocks an existing non-regular target instead of classifying it as created', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-write-preview-directory-');
        await mkdir(join(workspaceRoot, 'existing-directory'));
        const parsed = parsedWrite('existing-directory');

        // When
        const preview = await buildFileWritePreview(parsed, workspaceRoot);

        // Then
        expect(preview.operation).toBe('blocked');
        expect(preview).toHaveProperty('blockedReason', 'target_not_file');
        expect(renderFileWritePreview(preview, parsed.proposedContent)).toContain(
            'Preview unavailable: target is not a regular file',
        );
    });

    it('blocks an existing file when its preview read fails', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-write-preview-read-failure-');
        const targetPath = join(workspaceRoot, 'existing.txt');
        await writeFile(targetPath, 'existing content\n', 'utf8');
        openMock.mockRejectedValueOnce(new Error('deterministic existing-file read failure'));
        const parsed = parsedWrite('existing.txt');

        // When
        const preview = await buildFileWritePreview(parsed, workspaceRoot);

        // Then
        expect(openMock).toHaveBeenCalledWith(targetPath, 'r');
        expect(preview.operation).toBe('blocked');
        expect(preview).toHaveProperty('blockedReason', 'target_unreadable');
        expect(renderFileWritePreview(preview, parsed.proposedContent)).toContain(
            'Preview unavailable: target could not be read',
        );
    });

    it('classifies an ENOENT target as created', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-write-preview-missing-');
        const parsed = parsedWrite('missing.txt');

        // When
        const preview = await buildFileWritePreview(parsed, workspaceRoot);

        // Then
        expect(openMock).not.toHaveBeenCalled();
        expect(preview.operation).toBe('created');
    });

    it('blocks a target that cannot be inspected without a workspace root', async () => {
        // Given
        const parsed = parsedWrite('unknown.txt');

        // When
        const preview = await buildFileWritePreview(parsed, undefined);

        // Then
        expect(preview.operation).toBe('blocked');
        expect(preview).toHaveProperty('blockedReason', 'target_unreadable');
        expect(renderFileWritePreview(preview, parsed.proposedContent)).toContain(
            'Preview unavailable: target could not be read',
        );
    });
});

function parsedWrite(path: string) {
    const parsed = parseFileWritePreviewValue({ path, content: 'replacement content\n' });
    if (parsed === undefined) throw new Error('Expected parsed file.write preview');
    return parsed;
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
