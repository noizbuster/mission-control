import type { PermissionRule } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionRuleStore } from './store';
import { mkdirSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PermissionRuleStore commit hook', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('runs after the temp write and immediately before the atomic rename', async () => {
        // Given
        const dataDir = await tempRoot(roots);
        const store = new PermissionRuleStore({ dataDir });
        const trustDir = join(dataDir, 'trust');
        let filesAtCommit: readonly string[] = [];

        // When
        await store.appendRules([persistedRule()], {
            beforeCommit: () => {
                filesAtCommit = readdirSync(trustDir);
            },
        });

        // Then
        expect(filesAtCommit.some((name) => name.endsWith('.tmp'))).toBe(true);
        expect(filesAtCommit).not.toContain('permission-rules.json');
        await expect(readFile(store.filePath, 'utf8')).resolves.toContain('src/app.ts');
        await expect(readdir(trustDir)).resolves.toEqual(['permission-rules.json']);
    });

    it('removes the temp file and propagates a beforeCommit rejection', async () => {
        // Given
        const dataDir = await tempRoot(roots);
        const store = new PermissionRuleStore({ dataDir });

        // When
        const appending = store.appendRules([persistedRule()], {
            beforeCommit: () => {
                throw new PermissionStoreCommitTestError();
            },
        });

        // Then
        await expect(appending).rejects.toBeInstanceOf(PermissionStoreCommitTestError);
        await expect(readFile(store.filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readdir(join(dataDir, 'trust'))).resolves.toEqual([]);
    });

    it('removes the temp file and propagates an atomic rename failure', async () => {
        // Given
        const dataDir = await tempRoot(roots);
        const store = new PermissionRuleStore({ dataDir });
        const trustDir = join(dataDir, 'trust');

        // When
        const appending = store.appendRules([persistedRule()], {
            beforeCommit: () => mkdirSync(store.filePath),
        });

        // Then
        await expect(appending).rejects.toBeInstanceOf(Error);
        const remaining = await readdir(trustDir);
        expect(remaining).toEqual(['permission-rules.json']);
        expect(remaining.some((name) => name.endsWith('.tmp'))).toBe(false);
    });
});

function persistedRule(): PermissionRule {
    return { permission: 'patch', pattern: 'src/app.ts', decision: 'always', workspaceRoot: '/workspace' };
}

function ruleWithPattern(pattern: string): PermissionRule {
    return { permission: 'patch', pattern, decision: 'always', workspaceRoot: '/workspace' };
}

async function tempRoot(roots: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-permission-store-commit-'));
    roots.push(root);
    return root;
}

class PermissionStoreCommitTestError extends Error {
    readonly name = 'PermissionStoreCommitTestError';
}

describe('PermissionRuleStore concurrency', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('serializes concurrent appendRules without dropping rules', async () => {
        const dataDir = await tempRoot(roots);
        const store = new PermissionRuleStore({ dataDir });
        await Promise.all([
            store.appendRules([ruleWithPattern('a')]),
            store.appendRules([ruleWithPattern('b')]),
            store.appendRules([ruleWithPattern('c')]),
        ]);
        const rules = await store.listRules('/workspace');
        const patterns = rules.map((rule) => rule.pattern).sort();
        expect(patterns).toEqual(['a', 'b', 'c']);
    });
});
