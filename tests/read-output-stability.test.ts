import { registerReadOnlyRepoTools, ToolRegistry } from '@mission-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Contract: the default (untagged) `repo.read` output is byte-identical to its
// pre-tagged-read behavior. The `tagged` opt-in and the new `repo.read.tagged`
// tool must not alter what `repo.read` / `read` return when `tagged` is absent.
describe('repo.read output stability (untagged byte-identical)', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('returns the raw file bytes verbatim for an untagged read', async () => {
        const workspaceRoot = await createWorkspace();
        const raw = 'const greeting = "hi";\nexport { greeting };\n';
        await writeFile(join(workspaceRoot, 'hello.ts'), raw, 'utf8');
        const registry = await createRegistry(workspaceRoot);

        const settlement = await invokeRead(registry, 'repo.read', { path: 'hello.ts', summary: false });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as { readonly content: string };
        // Byte-identical to the on-disk content: no anchor prefixes, no elision.
        expect(output.content).toBe(raw);
        expect(output.content).not.toMatch(/^[0-9]+#[ZPMQVRWSNKTXJBYH]{2}\|/m);
    });

    it('returns a byte-identical window for offset/limit reads', async () => {
        const workspaceRoot = await createWorkspace();
        const raw = 'line1\nline2\nline3\nline4\nline5\n';
        await writeFile(join(workspaceRoot, 'win.txt'), raw, 'utf8');
        const registry = await createRegistry(workspaceRoot);

        const settlement = await invokeRead(registry, 'repo.read', { path: 'win.txt', offset: 2, limit: 2 });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as { readonly content: string };
        expect(output.content).toBe('line2\nline3');
    });

    it('produces no `NN#XX|` anchors in the default model output', async () => {
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'notes.txt'), 'alpha\nbeta\n', 'utf8');
        const registry = await createRegistry(workspaceRoot);

        const settlement = await invokeRead(registry, 'repo.read', { path: 'notes.txt' });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.result.output).not.toMatch(/^[0-9]+#[ZPMQVRWSNKTXJBYH]{2}\|/m);
        // The path header + content shape is preserved.
        expect(settlement.result.output).toContain('notes.txt\n');
    });

    it('keeps the `read` alias byte-identical to `repo.read`', async () => {
        const workspaceRoot = await createWorkspace();
        const raw = 'const x = 1;\nconst y = 2;\n';
        await writeFile(join(workspaceRoot, 'mod.ts'), raw, 'utf8');
        const registry = await createRegistry(workspaceRoot);

        const repo = await invokeRead(registry, 'repo.read', { path: 'mod.ts', summary: false });
        const alias = await invokeRead(registry, 'read', { path: 'mod.ts', summary: false });

        expect(alias.structuredOutput).toEqual(repo.structuredOutput);
        expect(alias.result.output).toBe(repo.result.output);
    });

    it('emits NN#XX| anchors only for repo.read.tagged, not for repo.read', async () => {
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'split.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
        const registry = await createRegistry(workspaceRoot);

        const untagged = await invokeRead(registry, 'repo.read', { path: 'split.ts', summary: false });
        const tagged = await invokeRead(registry, 'repo.read.tagged', { path: 'split.ts', summary: false });

        // Untagged: raw content, no anchors.
        expect((untagged.structuredOutput as { readonly content: string }).content).toBe(
            'const a = 1;\nconst b = 2;\n',
        );
        // Tagged: every line carries the NN#XX| anchor.
        const taggedContent = (tagged.structuredOutput as { readonly content: string }).content;
        expect(taggedContent.split('\n')[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|const a = 1;$/);
        expect(taggedContent.split('\n')[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|const b = 2;$/);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-read-stability-'));
        workspaces.push(workspace);
        return workspace;
    }

    async function createRegistry(workspaceRoot: string): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        await registerReadOnlyRepoTools(registry, { workspaceRoot });
        return registry;
    }

    async function invokeRead(registry: ToolRegistry, toolName: string, input: Record<string, unknown>) {
        const advertisement = registry.advertise().find((tool) => tool.name === toolName);
        if (advertisement === undefined) {
            throw new TypeError(`missing advertisement: ${toolName}`);
        }
        return registry.invoke({
            toolCallId: `${toolName.replace(/\./g, '_')}_call`,
            toolName,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });
    }
});
