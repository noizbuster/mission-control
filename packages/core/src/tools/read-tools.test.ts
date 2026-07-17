import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativesClient } from '../native/natives-client';
import { registerReadOnlyRepoTools } from './read-tools';
import { createWorkspaceGuard } from './read-tools-paths';
import type { ReadOutput } from './read-tools-schemas';
import { searchRepoText } from './read-tools-search';
import { ToolRegistry } from './tool-registry';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const addonRoot = process.cwd();
const defaultAddonPath = join(addonRoot, 'native', 'natives', 'index.node');
// The grep addon is an optional build artifact; the parity test only asserts
// behavior when it is present. The helper still wires a client when absent,
// which falls back to the TypeScript path so the rest of the suite is green.
const addonBuilt = existsSync(defaultAddonPath);

describe('read-only repo tools', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('registers compatibility tools and coding-agent aliases', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const registry = new ToolRegistry();

        // When
        const advertisements = await registerReadOnlyRepoTools(registry, { workspaceRoot });

        // Then
        expect(advertisements.map((tool) => tool.name)).toEqual([
            'repo.read',
            'repo.list',
            'repo.search',
            'read',
            'ls',
            'grep',
            'find',
            'repo.read.tagged',
        ]);
        expect(advertisements.map((tool) => tool.capabilityClasses)).toEqual([
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
        ]);
    });

    it('keeps coding-agent aliases output-identical to compatibility tools on safe paths', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'README.md'), 'alpha\nbeta\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'const alpha = 1;\nconst beta = 2;\n', 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const repoRead = await invokeTool(registry, 'repo.read', { path: 'README.md' });
        const aliasRead = await invokeTool(registry, 'read', { path: 'README.md' });
        const repoList = await invokeTool(registry, 'repo.list', { path: '.' });
        const aliasList = await invokeTool(registry, 'ls', { path: '.' });
        const repoSearch = await invokeTool(registry, 'repo.search', { pattern: 'alpha', path: '.' });
        const aliasGrep = await invokeTool(registry, 'grep', { pattern: 'alpha', path: '.' });
        const aliasFind = await invokeTool(registry, 'find', { pattern: 'alpha', path: '.' });

        // Then
        expect(aliasRead.structuredOutput).toEqual(repoRead.structuredOutput);
        expect(aliasRead.result.output).toBe(repoRead.result.output);
        expect(aliasList.structuredOutput).toEqual(repoList.structuredOutput);
        expect(aliasList.result.output).toBe(repoList.result.output);
        expect(aliasGrep.structuredOutput).toEqual(repoSearch.structuredOutput);
        expect(aliasGrep.result.output).toBe(repoSearch.result.output);
        expect(aliasFind.structuredOutput).toEqual(repoSearch.structuredOutput);
        expect(aliasFind.result.output).toBe(repoSearch.result.output);
    });

    it('reads workspace files with truncation metadata', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'notes.txt'), '0123456789abcdef', 'utf8');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, {
            maxReadBytes: 8,
            requestPermission: async (request) => {
                requests.push(request);
                return { requestId: request.id, status: 'allow', reason: 'test allow read' };
            },
        });
        const advertised = findAdvertisement(registry, 'repo.read');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'read_truncated',
            toolName: 'repo.read',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ path: 'notes.txt' }),
        });

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'file',
            path: 'notes.txt',
            content: '01234567',
            truncated: true,
            originalBytes: 16,
            returnedBytes: 8,
        });
        expect(settlement.result.output).toContain('truncated');
        expect(requests).toMatchObject([
            {
                action: 'repo.read',
                permission: {
                    kind: 'read',
                    patterns: ['notes.txt'],
                    workspaceRoot,
                },
            },
        ]);
    });

    it('rejects parent traversal and symlink escapes before reading', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot);
        const advertised = findAdvertisement(registry, 'repo.read');

        // When
        const traversal = await invokeRead(registry, advertised.version, '../secret.txt');
        const symlinkEscape = await invokeRead(registry, advertised.version, 'link.txt');

        // Then
        expect(traversal.result).toMatchObject({
            status: 'failed',
            error: { code: 'tool_failed' },
        });
        expect(traversal.result.error?.message).toContain('workspace_escape');
        expect(symlinkEscape.result.error?.message).toContain('workspace_escape');
    });

    it('rejects symlink escapes through parent path components for every read-only tool', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const outsideRoot = await createWorkspace();
        await mkdir(join(outsideRoot, 'nested'));
        await writeFile(join(outsideRoot, 'nested', 'secret.txt'), 'outside-secret', 'utf8');
        await symlink(join(outsideRoot, 'nested'), join(workspaceRoot, 'linked-dir'));
        await symlink(outsideRoot, join(workspaceRoot, 'linked-root'));
        const registry = await createRegistry(workspaceRoot);
        const readTool = findAdvertisement(registry, 'repo.read');
        const listTool = findAdvertisement(registry, 'repo.list');
        const searchTool = findAdvertisement(registry, 'repo.search');

        // When
        const read = await invokeRead(registry, readTool.version, 'linked-dir/secret.txt');
        const list = await registry.invoke({
            toolCallId: 'list_symlink_parent',
            toolName: 'repo.list',
            advertisedVersion: listTool.version,
            argumentsJson: JSON.stringify({ path: 'linked-root/nested' }),
        });
        const search = await registry.invoke({
            toolCallId: 'search_symlink_parent',
            toolName: 'repo.search',
            advertisedVersion: searchTool.version,
            argumentsJson: JSON.stringify({ pattern: 'outside-secret', path: 'linked-dir/secret.txt' }),
        });

        // Then
        expect(read.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(list.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(search.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(read.result.error?.message).toContain('workspace_escape');
        expect(list.result.error?.message).toContain('workspace_escape');
        expect(search.result.error?.message).toContain('workspace_escape');
    });

    it('returns typed failures for missing and binary files', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]));
        const registry = await createRegistry(workspaceRoot);

        // When
        const repoRead = findAdvertisement(registry, 'repo.read');
        const missing = await invokeRead(registry, repoRead.version, 'missing.txt');
        const binary = await invokeRead(registry, repoRead.version, 'image.bin');
        const aliasBinary = await invokeTool(registry, 'read', { path: 'image.bin' });

        // Then
        expect(missing.result.error?.message).toContain('not_found');
        expect(binary.result.error?.message).toContain('binary_file');
        expect(aliasBinary.result.error?.message).toContain('binary_file');
    });

    it('applies search caps and no-match behavior to grep and find aliases', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle one\nneedle two is a long line', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle three', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxSearchLineChars: 10, maxSearchMatches: 2 });

        // When
        const grep = await invokeTool(registry, 'grep', { pattern: 'needle', path: 'src' });
        const find = await invokeTool(registry, 'find', { pattern: 'needle', path: 'src' });
        const grepNoMatch = await invokeTool(registry, 'grep', { pattern: 'absent', path: 'src' });
        const findNoMatch = await invokeTool(registry, 'find', { pattern: 'absent', path: 'src' });

        // Then
        expect(grep.structuredOutput).toMatchObject({
            kind: 'search',
            pattern: 'needle',
            truncated: true,
            totalMatches: 3,
            matches: [
                { path: 'src/a.ts', line: 1, text: 'needle one', textTruncated: false },
                { path: 'src/a.ts', line: 2, text: 'needle ...', textTruncated: true },
            ],
        });
        expect(find.structuredOutput).toEqual(grep.structuredOutput);
        expect(grep.result.output).toContain('[truncated: 2 of 3 matches returned]');
        expect(find.result.output).toContain('[truncated: 2 of 3 matches returned]');
        expect(grepNoMatch.result.output).toBe('No matches for absent');
        expect(findNoMatch.result.output).toBe('No matches for absent');
    });

    it('lists workspace directories with entry bounds', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'b.txt'), 'b', 'utf8');
        await writeFile(join(workspaceRoot, 'a.txt'), 'a', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxListEntries: 2 });
        const advertised = findAdvertisement(registry, 'repo.list');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'list_root',
            toolName: 'repo.list',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ path: '.' }),
        });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'directory',
            path: '.',
            entries: [
                { name: 'a.txt', kind: 'file' },
                { name: 'b.txt', kind: 'file' },
            ],
            truncated: true,
            totalEntries: 3,
        });
    });

    it('searches text files with match and line bounds', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle one\nneedle two is a long line', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle three', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxSearchLineChars: 10, maxSearchMatches: 2 });
        const advertised = findAdvertisement(registry, 'repo.search');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'search_needles',
            toolName: 'repo.search',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ pattern: 'needle', path: 'src' }),
        });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'search',
            pattern: 'needle',
            truncated: true,
            totalMatches: 3,
            matches: [
                { path: 'src/a.ts', line: 1, text: 'needle one', textTruncated: false },
                { path: 'src/a.ts', line: 2, text: 'needle ...', textTruncated: true },
            ],
        });
    });

    it('produces output-identical results from the N-API and TypeScript search paths', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src', 'nested'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle one\nneedle two\nunrelated\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'nested', 'b.ts'), 'needle three\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'c.md'), 'needle in markdown\n', 'utf8');
        const guard = await createWorkspaceGuard(workspaceRoot);
        const natives = createNativesClient({ onWarning: () => {} });
        const input = { pattern: 'needle', path: 'src' };
        const opts = { maxMatches: 2, maxLineChars: 12 };

        // When
        const viaTs = await searchRepoText(guard, input, opts);
        const viaNapi = await searchRepoText(guard, input, opts, natives);

        // Then: the N-API path must agree with the TypeScript path exactly,
        // including match order, truncation, and the true total count.
        if (addonBuilt) {
            expect(viaNapi).toEqual(viaTs);
            expect(viaNapi.totalMatches).toBe(4);
            expect(viaNapi.matches).toHaveLength(2);
            expect(viaNapi.matches[0]).toMatchObject({
                path: 'src/a.ts',
                line: 1,
                text: 'needle one',
                textTruncated: false,
            });
        } else {
            // Without the addon both calls hit the TypeScript path, so they
            // are trivially identical; the assertion still guards the wiring.
            expect(viaNapi).toEqual(viaTs);
        }
    });

    // A TypeScript fixture with an import run plus function and class bodies
    // large enough to elide. Shared by the summary tests below.
    function summaryFixture(): string {
        return [
            'import { foo } from "foo";',
            'import { bar } from "bar";',
            'import { baz } from "baz";',
            'import { qux } from "qux";',
            'import { quux } from "quux";',
            '',
            'export function greet(name: string): string {',
            '  const clean = name.trim();',
            '  const label = clean || "world";',
            '  const upper = label.toUpperCase();',
            '  return `hello ${upper}`;',
            '}',
            '',
            'export class Greeter {',
            '  private name: string = "world";',
            '  greet(): string { return this.name; }',
            '  shout(): string { return this.name.toUpperCase(); }',
            '  whisper(): string { return this.name.toLowerCase(); }',
            '}',
        ].join('\n');
    }

    it('returns the raw source by default so function bodies stay readable', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'mod.ts'), summaryFixture(), 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'repo.read', { path: 'mod.ts' });

        // Then: default is the verbatim line window, not a structural summary.
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.summarized).toBeUndefined();
        expect(output.content).toContain('import { bar }');
        expect(output.content).toContain('return `hello ${upper}`');
        expect(output.content).not.toContain('lines elided');
    });

    it.skipIf(!addonBuilt)('summarizes a TypeScript file only when summary is true', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'mod.ts'), summaryFixture(), 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'repo.read', { path: 'mod.ts', summary: true });

        // Then: opt-in summary keeps imports + signatures and elides bodies.
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.summarized).toBe(true);
        expect(output.elidedLines).toBeGreaterThan(0);
        expect(output.content).toContain('import { foo }');
        expect(output.content).toContain('export function greet');
        expect(output.content).toContain('export class Greeter');
        expect(output.content).toContain('lines elided');
        expect(output.content).not.toContain('import { bar }');
        expect(output.content).not.toContain('return `hello ${upper}`');
        expect(settlement.result.output).toContain('structural summary');
    });

    it('pages large files with offset and limit parameters', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
        await writeFile(join(workspaceRoot, 'big.txt'), `${lines.join('\n')}\n`, 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'repo.read', { path: 'big.txt', offset: 10, limit: 3 });

        // Then
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.content).toBe('line-10\nline-11\nline-12');
        expect(output.truncated).toBe(true);
    });

    it('returns mid-file offset windows even when the target is larger than the binary-sniff sample', async () => {
        // Given: >4KB of content so a naive sample-only reader would drop
        // lines past the sniff prefix and return an empty offset window.
        const workspaceRoot = await createWorkspace();
        const lines = Array.from({ length: 400 }, (_, index) => `payload-line-${index + 1}-${'x'.repeat(20)}`);
        await writeFile(join(workspaceRoot, 'wide.ts'), `${lines.join('\n')}\n`, 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'read', {
            path: 'wide.ts',
            offset: 200,
            limit: 5,
            summary: false,
        });

        // Then
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.content).toContain('payload-line-200-');
        expect(output.content).toContain('payload-line-204-');
        expect(output.content).not.toBe('');
        expect(settlement.result.output).not.toMatch(/truncated: 4096 of/);
    });

    it('falls back to raw text for unsupported languages without crashing', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'data.xyz'), 'line one\nline two\nline three\n', 'utf8');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'repo.read', { path: 'data.xyz' });

        // Then: an unknown extension is returned verbatim, never summarized.
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.summarized).toBeUndefined();
        expect(output.content).toBe('line one\nline two\nline three\n');
    });

    it('falls back to raw text when the native addon is unavailable', async () => {
        // Given: a client pointed at a nonexistent addon, so summarizeCode
        // resolves to null and the read degrades to raw text even for a
        // supported language.
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'mod.ts'), summaryFixture(), 'utf8');
        const natives = createNativesClient({
            addonPath: join(workspaceRoot, 'does-not-exist.node'),
            onWarning: () => {},
        });
        expect(natives.available).toBe(false);
        const registry = new ToolRegistry();
        await registerReadOnlyRepoTools(registry, { workspaceRoot, natives });

        // When
        const settlement = await invokeTool(registry, 'repo.read', { path: 'mod.ts' });

        // Then
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as ReadOutput;
        expect(output.summarized).toBeUndefined();
        expect(output.content).toContain('return `hello ${upper}`');
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-read-tools-'));
        workspaces.push(workspace);
        return workspace;
    }
});

type ReadToolOptions = Parameters<typeof registerReadOnlyRepoTools>[1];

async function createRegistry(workspaceRoot: string, options: Partial<ReadToolOptions> = {}): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    // Wire the native grep addon so the search tools exercise the N-API path
    // when the build is present, and transparently fall back otherwise.
    const natives = options.natives ?? createNativesClient({ onWarning: () => {} });
    await registerReadOnlyRepoTools(registry, { ...options, natives, workspaceRoot });
    return registry;
}

function findAdvertisement(registry: ToolRegistry, name: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === name);
    if (advertisement === undefined) {
        throw new TypeError(`missing advertisement: ${name}`);
    }
    return advertisement;
}

async function invokeRead(registry: ToolRegistry, advertisedVersion: string, path: string) {
    return invokeToolWithVersion(registry, 'repo.read', advertisedVersion, { path });
}

async function invokeTool(registry: ToolRegistry, toolName: string, input: Record<string, unknown>) {
    const advertised = findAdvertisement(registry, toolName);
    return invokeToolWithVersion(registry, toolName, advertised.version, input);
}

async function invokeToolWithVersion(
    registry: ToolRegistry,
    toolName: string,
    advertisedVersion: string,
    input: Record<string, unknown>,
) {
    return registry.invoke({
        toolCallId: `${toolName.replaceAll(/[^a-z0-9]+/gi, '_')}_call`,
        toolName,
        advertisedVersion,
        argumentsJson: JSON.stringify(input),
    });
}
