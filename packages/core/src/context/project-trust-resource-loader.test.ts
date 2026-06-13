import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustStore } from '../trust/project-trust-store.js';
import { loadProjectResources } from './project-resource-loader.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadProjectResources', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('does not load project-local context when trust is unknown or denied', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspaceRoot = await createWorkspaceWithAgents('UNKNOWN_OR_DENIED_CONTEXT');
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });

        // When
        const unknown = await loadProjectResources({
            workspaceRoot,
            trustStore: store,
            paths: ['AGENTS.md'],
        });
        await store.setDecision(workspaceRoot, 'denied');
        const denied = await loadProjectResources({
            workspaceRoot,
            trustStore: store,
            paths: ['AGENTS.md'],
        });

        // Then
        expect(unknown).toMatchObject({ status: 'skipped', trustDecision: 'unknown', resources: [] });
        expect(denied).toMatchObject({ status: 'skipped', trustDecision: 'denied', resources: [] });
        expect(JSON.stringify([unknown, denied])).not.toContain('UNKNOWN_OR_DENIED_CONTEXT');
    });

    it('loads trusted project context but denies temp ref-repo instructions', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspaceRoot = await createWorkspaceWithAgents('TRUSTED_CONTEXT');
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(
            join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'AGENTS.md'),
            'REF_REPO_PROMPT_INJECTION',
            'utf8',
        );
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });
        await store.setDecision(workspaceRoot, 'trusted');

        // When
        const loaded = await loadProjectResources({
            workspaceRoot,
            trustStore: store,
            paths: ['AGENTS.md', 'temp/ref-repos/opencode/AGENTS.md'],
        });

        // Then
        expect(loaded.status).toBe('loaded');
        if (loaded.status !== 'loaded') {
            throw new Error('expected trusted resources to load');
        }
        expect(loaded.resources).toEqual([
            {
                path: 'AGENTS.md',
                content: 'TRUSTED_CONTEXT',
                truncated: false,
            },
        ]);
        expect(loaded.deniedResources).toEqual([
            {
                path: 'temp/ref-repos/opencode/AGENTS.md',
                reason: expect.stringContaining('workspace_denied'),
            },
        ]);
        expect(JSON.stringify(loaded)).not.toContain('REF_REPO_PROMPT_INJECTION');
    });

    it('denies mixed-case temp ref-repo instructions when trusted', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspaceRoot = await createWorkspaceWithAgents('TRUSTED_CONTEXT');
        await mkdir(join(workspaceRoot, 'Temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(
            join(workspaceRoot, 'Temp', 'ref-repos', 'opencode', 'AGENTS.md'),
            'MIXED_CASE_PROMPT_INJECTION',
            'utf8',
        );
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });
        await store.setDecision(workspaceRoot, 'trusted');

        // When
        const loaded = await loadProjectResources({
            workspaceRoot,
            trustStore: store,
            paths: ['Temp/ref-repos/opencode/AGENTS.md'],
        });

        // Then
        expect(loaded.status).toBe('loaded');
        if (loaded.status !== 'loaded') {
            throw new Error('expected trusted resources to load');
        }
        expect(loaded.resources).toEqual([]);
        expect(loaded.deniedResources).toEqual([
            {
                path: 'Temp/ref-repos/opencode/AGENTS.md',
                reason: expect.stringContaining('workspace_denied'),
            },
        ]);
        expect(JSON.stringify(loaded)).not.toContain('MIXED_CASE_PROMPT_INJECTION');
    });

    it('dedupes resources by resolved absolute path', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspaceRoot = await createWorkspaceWithAgents('DEDUPED_CONTEXT');
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });
        await store.setDecision(workspaceRoot, 'trusted');

        // When
        const loaded = await loadProjectResources({
            workspaceRoot,
            trustStore: store,
            paths: ['AGENTS.md', './AGENTS.md'],
        });

        // Then
        expect(loaded.status).toBe('loaded');
        if (loaded.status !== 'loaded') {
            throw new Error('expected trusted resources to load');
        }
        expect(loaded.resources).toEqual([
            {
                path: 'AGENTS.md',
                content: 'DEDUPED_CONTEXT',
                truncated: false,
            },
        ]);
    });

    async function createWorkspaceWithAgents(content: string): Promise<string> {
        const root = await tempRoot('mctrl-trust-workspace-');
        await writeFile(join(root, 'AGENTS.md'), content, 'utf8');
        return root;
    }

    async function tempRoot(prefix: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        return root;
    }
});

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}
