import type { ToolCall } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToolPreview } from './interactive-coding-tool-preview.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('interactive coding tool preview', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('redacts token-like secrets in raw file.patch file.edit file.write and command.run arguments', async () => {
        // Given
        const secret = ['sk', 'tool_preview_123'].join('-');
        const output = createBufferedChatOutput();
        const workspaceRoot = await tempRoot('mctrl-tool-preview-');
        await writeFile(join(workspaceRoot, 'existing.txt'), 'before\n', 'utf8');

        // When
        await renderToolPreview(
            toolCall('command.run', 'command_preview', {
                command: 'pnpm',
                args: ['exec', 'vitest', 'run', `${secret}.test.ts`],
            }),
            output.output,
            workspaceRoot,
        );
        await renderToolPreview(
            toolCall('file.patch', 'patch_preview', { patch: addFilePatch('.preview-secret.txt', secret) }),
            output.output,
            workspaceRoot,
        );
        await renderToolPreview(
            toolCall('file.edit', 'edit_preview', {
                path: 'notes.txt',
                oldText: `before ${secret}`,
                newText: `after ${secret}`,
                occurrence: 2,
            }),
            output.output,
            workspaceRoot,
        );
        await renderToolPreview(
            toolCall('file.write', 'write_preview_replace', {
                path: 'existing.txt',
                content: `after ${secret}\n`,
            }),
            output.output,
            workspaceRoot,
        );

        // Then
        expect(output.getOutput()).toContain('[REDACTED_CREDENTIAL]');
        expect(output.getOutput()).not.toContain(secret);
        expect(output.getOutput()).toContain('Edit preview for file.edit');
        expect(output.getOutput()).toContain('Replace preview for file.write');
        expect(output.getOutput()).toContain('--- a/notes.txt');
        expect(output.getOutput()).toContain('+++ b/notes.txt');
    });

    it('falls back to raw arguments for ambiguous file.edit selector input', async () => {
        const output = createBufferedChatOutput();

        await renderToolPreview(
            toolCall('file.edit', 'edit_ambiguous', {
                path: 'notes.txt',
                oldText: 'before',
                newText: 'after',
                occurrence: 1,
                replaceAll: false,
            }),
            output.output,
        );

        expect(output.getOutput()).toContain('Edit preview for file.edit');
        expect(output.getOutput()).toContain('"replaceAll":false');
        expect(output.getOutput()).not.toContain('--- a/notes.txt');
        expect(output.getOutput()).not.toContain('+++ b/notes.txt');
    });

    it('distinguishes create previews for new file.write targets and shows explicit parent creation', async () => {
        const output = createBufferedChatOutput();
        const workspaceRoot = await tempRoot('mctrl-tool-preview-create-');

        await renderToolPreview(
            toolCall('file.write', 'write_preview_create', {
                path: 'nested/new.txt',
                content: 'created\n',
                createParents: true,
            }),
            output.output,
            workspaceRoot,
        );

        expect(output.getOutput()).toContain('Create preview for file.write');
        expect(output.getOutput()).toContain('Target: nested/new.txt');
        expect(output.getOutput()).toContain('Create parent directories: yes');
        expect(output.getOutput()).toContain('+++ b/nested/new.txt');
    });

    it('blocks file.write preview reads for absolute workspace escapes', async () => {
        const output = createBufferedChatOutput();
        const workspaceRoot = await tempRoot('mctrl-tool-preview-escape-');
        const outsideRoot = await tempRoot('mctrl-tool-preview-outside-');
        const outsidePath = join(outsideRoot, 'outside.txt');
        await writeFile(outsidePath, 'outside secret\n', 'utf8');

        await renderToolPreview(
            toolCall('file.write', 'write_preview_escape', {
                path: outsidePath,
                content: 'replacement\n',
            }),
            output.output,
            workspaceRoot,
        );

        expect(output.getOutput()).toContain('Write preview for file.write');
        expect(output.getOutput()).toContain('Preview blocked until approval');
        expect(output.getOutput()).not.toContain('outside secret');
        expect(output.getOutput()).not.toContain('--- a/');
    });

    it('blocks file.write preview reads for symlink paths inside the workspace', async () => {
        const output = createBufferedChatOutput();
        const workspaceRoot = await tempRoot('mctrl-tool-preview-symlink-');
        await writeFile(join(workspaceRoot, 'target.txt'), 'secret target\n', 'utf8');
        await symlink(join(workspaceRoot, 'target.txt'), join(workspaceRoot, 'link.txt'));

        await renderToolPreview(
            toolCall('file.write', 'write_preview_symlink', {
                path: 'link.txt',
                content: 'replacement\n',
            }),
            output.output,
            workspaceRoot,
        );

        expect(output.getOutput()).toContain('Write preview for file.write');
        expect(output.getOutput()).toContain('Preview blocked until approval');
        expect(output.getOutput()).not.toContain('secret target');
        expect(output.getOutput()).not.toContain('--- a/link.txt');
    });

    it('blocks file.write preview reads for symlinked parent directories', async () => {
        const output = createBufferedChatOutput();
        const workspaceRoot = await tempRoot('mctrl-tool-preview-symlink-parent-');
        await writeFile(join(workspaceRoot, 'target.txt'), 'secret target\n', 'utf8');
        await symlink(join(workspaceRoot, 'target.txt'), join(workspaceRoot, 'linked'));

        await renderToolPreview(
            toolCall('file.write', 'write_preview_symlink_parent', {
                path: 'linked/child.txt',
                content: 'replacement\n',
            }),
            output.output,
            workspaceRoot,
        );

        expect(output.getOutput()).toContain('Write preview for file.write');
        expect(output.getOutput()).toContain('Preview blocked until approval');
        expect(output.getOutput()).not.toContain('secret target');
        expect(output.getOutput()).not.toContain('+++ b/linked/child.txt');
    });
});

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
