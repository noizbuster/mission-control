import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { applyHashlineEdits, dedupeEdits, normalizeEdits } from './hashline/edit-operations';
import { computeLineHash, formatHashLine, formatHashLines } from './hashline/hash-computation';
import { executeHashlineEdits } from './hashline/hashline-edit-executor';
import { HashlineMismatchError, parseLineRef, validateLineRefs } from './hashline/validation';
import { createHashlineEditToolRegistration, type HashlineEditToolOptions } from './hashline-edit';
import { ToolRegistry } from './tool-registry';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('hashline algorithm (clean-room)', () => {
    describe('hash computation', () => {
        it('mints a deterministic 2-char CID from the ZPMQVRWSNKTXJBYH alphabet', () => {
            const hash = computeLineHash(1, 'function hello() {');
            expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
            // Deterministic: same content + line -> same CID.
            expect(computeLineHash(1, 'function hello() {')).toBe(hash);
        });

        it('tags read output as NN#XX|content lines', () => {
            const tagged = formatHashLines('alpha\nbeta\n');
            const lines = tagged.split('\n');
            expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}\|alpha$/);
            expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}\|beta$/);
            // The trailing empty line (from the trailing newline) tags at line 3.
            expect(lines[2]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}\|$/);
        });

        it('gives distinct CIDs to whitespace-only lines by seeding on position', () => {
            const blank1 = computeLineHash(1, '');
            const blank2 = computeLineHash(2, '');
            const blank3 = computeLineHash(3, '   ');
            // Blank lines at different positions must not all collide.
            expect(new Set([blank1, blank2, blank3]).size).toBeGreaterThan(1);
        });

        it('is insensitive to trailing whitespace and carriage returns', () => {
            const base = computeLineHash(5, 'const x = 1;');
            expect(computeLineHash(5, 'const x = 1;\r')).toBe(base);
            expect(computeLineHash(5, 'const x = 1;   ')).toBe(base);
        });

        it('parses a NN#XX anchor reference', () => {
            expect(parseLineRef('42#VK')).toEqual({ line: 42, hash: 'VK' });
            // Tolerant of a pasted tagged line: extracts the anchor.
            expect(parseLineRef('42#VK| function hello() {')).toEqual({ line: 42, hash: 'VK' });
        });
    });

    describe('replace by LINE#ID anchor', () => {
        it('replaces a single line referenced by its anchor', () => {
            const content = 'const greeting = "hi";\nexport { greeting };\n';
            const anchor = `1#${computeLineHash(1, 'const greeting = "hi";')}`;
            const result = applyHashlineEdits(content, [
                { op: 'replace', pos: anchor, lines: 'const greeting = "hello";' },
            ]);
            expect(result).toBe('const greeting = "hello";\nexport { greeting };\n');
        });

        it('replaces a pos..end range', () => {
            const content = 'a\nb\nc\nd\n';
            const start = `1#${computeLineHash(1, 'a')}`;
            const end = `3#${computeLineHash(3, 'c')}`;
            const result = applyHashlineEdits(content, [{ op: 'replace', pos: start, end, lines: 'X\nY\nZ' }]);
            expect(result).toBe('X\nY\nZ\nd\n');
        });

        it('deletes a line when lines is null', () => {
            const content = 'a\nb\nc\n';
            const anchor = `2#${computeLineHash(2, 'b')}`;
            const result = applyHashlineEdits(content, [{ op: 'replace', pos: anchor, lines: null }]);
            expect(result).toBe('a\nc\n');
        });
    });

    describe('append and prepend', () => {
        it('appends after an anchor', () => {
            const content = 'a\nb\n';
            const anchor = `1#${computeLineHash(1, 'a')}`;
            const result = applyHashlineEdits(content, [{ op: 'append', pos: anchor, lines: 'a2' }]);
            expect(result).toBe('a\na2\nb\n');
        });

        it('appends at EOF when no anchor', () => {
            const content = 'a\nb\n';
            const result = applyHashlineEdits(content, [{ op: 'append', lines: 'c' }]);
            expect(result).toBe('a\nb\nc\n');
        });

        it('prepends before an anchor', () => {
            const content = 'a\nb\n';
            const anchor = `2#${computeLineHash(2, 'b')}`;
            const result = applyHashlineEdits(content, [{ op: 'prepend', pos: anchor, lines: 'b0' }]);
            expect(result).toBe('a\nb0\nb\n');
        });

        it('prepends at BOF when no anchor', () => {
            const content = 'a\nb\n';
            const result = applyHashlineEdits(content, [{ op: 'prepend', lines: 'z' }]);
            expect(result).toBe('z\na\nb\n');
        });
    });

    describe('stale-anchor rejection', () => {
        it('rejects when the referenced line changed since the read (no corruption)', () => {
            const original = 'const greeting = "hi";\nexport { greeting };\n';
            const staleAnchor = `1#${computeLineHash(1, 'const greeting = "hi";')}`;
            // The file drifted: line 1 is now different.
            const drifted = 'const greeting = "yo";\nexport { greeting };\n';
            expect(() => applyHashlineEdits(drifted, [{ op: 'replace', pos: staleAnchor, lines: 'nope;' }])).toThrow(
                HashlineMismatchError,
            );
        });

        it('reports corrected remap entries on mismatch', () => {
            const drifted = 'const greeting = "yo";\nexport { greeting };\n';
            const staleAnchor = `1#${computeLineHash(1, 'const greeting = "hi";')}`;
            const lines = drifted.split('\n');
            let caught: HashlineMismatchError | undefined;
            try {
                validateLineRefs(lines, [staleAnchor]);
            } catch (error) {
                if (error instanceof HashlineMismatchError) {
                    caught = error;
                }
            }
            expect(caught).toBeDefined();
            const actualHash = computeLineHash(1, 'const greeting = "yo";');
            expect(caught?.remaps.get(`1#${computeLineHash(1, 'const greeting = "hi";')}`)).toBe(`1#${actualHash}`);
            expect(caught?.message).toContain('>>>');
        });
    });

    describe('ordering, dedup, overlap', () => {
        it('applies multiple edits bottom-up so earlier anchors stay valid', () => {
            const content = 'a\nb\nc\n';
            const a1 = `1#${computeLineHash(1, 'a')}`;
            const c3 = `3#${computeLineHash(3, 'c')}`;
            const result = applyHashlineEdits(content, [
                { op: 'replace', pos: a1, lines: 'A' },
                { op: 'replace', pos: c3, lines: 'C' },
            ]);
            expect(result).toBe('A\nb\nC\n');
        });

        it('deduplicates identical edits', () => {
            const edits = normalizeEdits([
                { op: 'append', lines: 'x' },
                { op: 'append', lines: 'x' },
            ]);
            expect(dedupeEdits(edits).deduplicatedEdits).toBe(1);
        });

        it('rejects overlapping replace ranges', () => {
            const content = 'a\nb\nc\nd\n';
            const s1 = `1#${computeLineHash(1, 'a')}`;
            const e3 = `3#${computeLineHash(3, 'c')}`;
            const s2 = `2#${computeLineHash(2, 'b')}`;
            const e4 = `4#${computeLineHash(4, 'd')}`;
            expect(() =>
                applyHashlineEdits(content, [
                    { op: 'replace', pos: s1, end: e3, lines: 'X' },
                    { op: 'replace', pos: s2, end: e4, lines: 'Y' },
                ]),
            ).toThrow(/Overlapping range edits/);
        });
    });

    describe('autocorrect', () => {
        it('restores leading indentation on a replacement that lost it', () => {
            const content = '    const a = 1;\n';
            const anchor = `1#${computeLineHash(1, '    const a = 1;')}`;
            const result = applyHashlineEdits(content, [{ op: 'replace', pos: anchor, lines: 'const b = 2;' }]);
            expect(result).toBe('    const b = 2;\n');
        });
    });
});

describe('hashline_edit tool', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('replaces a line by its LINE#ID anchor through the mutation queue', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'hello.ts', 'const greeting = "hi";\nexport { greeting };\n');
        const registry = await createRegistry(workspaceRoot);
        const anchor = `1#${computeLineHash(1, 'const greeting = "hi";')}`;

        // When
        const settlement = await invokeTool(registry, 'hashline_edit', {
            path: 'hello.ts',
            edits: [{ op: 'replace', pos: anchor, lines: 'const greeting = "hello";' }],
        });

        // Then
        expect(settlement.result.status).toBe('completed');
        const onDisk = await readFile(join(workspaceRoot, 'hello.ts'), 'utf8');
        expect(onDisk).toBe('const greeting = "hello";\nexport { greeting };\n');
    });

    it('rejects a stale anchor and leaves the file unchanged', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'stale.ts', 'const greeting = "hi";\n');
        const staleAnchor = `1#${computeLineHash(1, 'const greeting = "hi";')}`;
        // Drift the file after computing the anchor; allow the dirty path so the
        // stale-anchor hash check (not the dirty guard) is what rejects the edit.
        await writeFile(join(workspaceRoot, 'stale.ts'), 'const greeting = "yo";\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, { allowDirtyPaths: ['stale.ts'] });

        // When
        const settlement = await invokeTool(registry, 'hashline_edit', {
            path: 'stale.ts',
            edits: [{ op: 'replace', pos: staleAnchor, lines: 'nope;' }],
        });

        // Then: rejected, file untouched.
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toMatch(/hash mismatch|changed since last read|Hashline/i);
        const onDisk = await readFile(join(workspaceRoot, 'stale.ts'), 'utf8');
        expect(onDisk).toBe('const greeting = "yo";\n');
    });

    it('appends and prepends without an anchor (BOF/EOF)', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'lines.txt', 'middle\n');
        // The second edit runs against a file the first edit already modified, so
        // allow the dirty path to reach the apply rather than trip the dirty guard.
        const registry = await createRegistry(workspaceRoot, { allowDirtyPaths: ['lines.txt'] });

        // When
        const append = await invokeTool(registry, 'hashline_edit', {
            path: 'lines.txt',
            edits: [{ op: 'append', lines: 'end' }],
        });
        const prepend = await invokeTool(registry, 'hashline_edit', {
            path: 'lines.txt',
            edits: [{ op: 'prepend', lines: 'start' }],
        });

        // Then
        expect(append.result.status).toBe('completed');
        expect(prepend.result.status).toBe('completed');
        expect(await readFile(join(workspaceRoot, 'lines.txt'), 'utf8')).toBe('start\nmiddle\nend\n');
    });

    it('deletes the file when delete: true', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'gone.txt', 'bye\n');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'hashline_edit', { path: 'gone.txt', edits: [], delete: true });

        // Then
        expect(settlement.result.status).toBe('completed');
        await expect(readFile(join(workspaceRoot, 'gone.txt'), 'utf8')).rejects.toThrow();
    });

    it('rejects a replace missing pos at the schema layer', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'x.txt', 'a\n');
        const registry = await createRegistry(workspaceRoot);

        // When
        const settlement = await invokeTool(registry, 'hashline_edit', {
            path: 'x.txt',
            edits: [{ op: 'replace', lines: 'b' }],
        });

        // Then
        expect(settlement.result.status).toBe('failed');
    });

    it('round-trips: a tagged read anchor drives a successful hashline_edit', async () => {
        // Given: the same line hash the read.tagged view emits is exactly what
        // hashline_edit validates against, so an anchor lifted from a tagged
        // read applies cleanly.
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'round.ts', 'const greeting = "hi";\nexport { greeting };\n');
        const registry = await createRegistry(workspaceRoot, { allowDirtyPaths: ['round.ts'] });

        // When: simulate the model lifting the `1#XX` anchor from a tagged read.
        const anchor = formatHashLines('const greeting = "hi";\nexport { greeting };\n').split('\n')[0]?.split('|')[0];
        expect(anchor).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}$/);
        const settlement = await invokeTool(registry, 'hashline_edit', {
            path: 'round.ts',
            edits: [{ op: 'replace', pos: anchor ?? '1#ZZ', lines: 'const greeting = "hello";' }],
        });

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(await readFile(join(workspaceRoot, 'round.ts'), 'utf8')).toBe(
            'const greeting = "hello";\nexport { greeting };\n',
        );
    });

    async function createGitWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-hashline-'));
        workspaces.push(workspace);
        await execFileAsync('git', ['init'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspace });
        return workspace;
    }

    async function trackedFile(root: string, path: string, content: string): Promise<void> {
        await writeFile(join(root, path), content, 'utf8');
        await execFileAsync('git', ['add', path], { cwd: root });
        await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: root });
    }

    async function createRegistry(
        workspaceRoot: string,
        extra: Partial<HashlineEditToolOptions> = {},
    ): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        await registry.register(
            await createHashlineEditToolRegistration({
                workspaceRoot,
                requestPermission: (request: PermissionRequest): PermissionDecision => ({
                    requestId: request.id,
                    status: 'allow',
                    reason: 'test allow',
                }),
                ...extra,
            }),
        );
        return registry;
    }

    async function invokeTool(registry: ToolRegistry, toolName: string, input: Record<string, unknown>) {
        const advertisement = registry.advertise().find((tool) => tool.name === toolName);
        if (advertisement === undefined) {
            throw new TypeError(`missing advertisement: ${toolName}`);
        }
        return registry.invoke({
            toolCallId: `${toolName}_call`,
            toolName,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });
    }
});

// Re-export formatHashLine for the round-trip expectations above without a
// separate import block.
export { formatHashLine };
