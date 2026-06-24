import { ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXED_DATE = new Date('2026-06-19T00:00:00.000Z');

describe('buildCodingAgentSystemPromptEnv', () => {
    it('includes cwd, workspaceRoot, platform, date, and gitEnabled for a real workspace', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-env-real-'));
        try {
            // The repo root is a git workspace; mkdtemp is outside the repo so create a subdir under
            // the repo to verify git detection works against a real work tree.
            const env = await buildCodingAgentSystemPromptEnv({
                workspaceRoot,
                modelId: 'claude-fable-5',
                cwd: '/custom/cwd',
                platform: 'linux',
                now: () => FIXED_DATE,
            });

            expect(env.cwd).toBe('/custom/cwd');
            expect(env.workspaceRoot).toBe(workspaceRoot);
            expect(env.platform).toBe('linux');
            expect(env.date).toBe(FIXED_DATE.toISOString());
            expect(env.modelId).toBe('claude-fable-5');
            expect(typeof env.gitEnabled).toBe('boolean');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('detects a git work tree (the mission-control repo itself)', async () => {
        const env = await buildCodingAgentSystemPromptEnv({
            workspaceRoot: process.cwd(),
            now: () => FIXED_DATE,
        });
        expect(env.gitEnabled).toBe(true);
    });

    it('omits modelId when not supplied', async () => {
        const env = await buildCodingAgentSystemPromptEnv({
            workspaceRoot: process.cwd(),
            now: () => FIXED_DATE,
        });
        expect(env.modelId).toBeUndefined();
    });
});

describe('loadTrustedProjectInstructionResources', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function makeTempWorkspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'mctrl-resources-'));
        roots.push(root);
        return root;
    }

    it('returns an empty array when the workspace is not trusted', async () => {
        const workspaceRoot = await makeTempWorkspace();
        await writeFile(join(workspaceRoot, 'AGENTS.md'), 'UNTRUSTED_CONTENT', 'utf8');
        const trustStore = new ProjectTrustStore({ dataDir: await makeTempWorkspace() });

        const resources = await loadTrustedProjectInstructionResources(workspaceRoot, trustStore);

        expect(resources).toEqual([]);
    });

    it('loads AGENTS.md and CLAUDE.md from a trusted workspace, mapping to ProjectInstructionResource', async () => {
        const workspaceRoot = await makeTempWorkspace();
        await writeFile(join(workspaceRoot, 'AGENTS.md'), 'Always use pnpm.', 'utf8');
        await writeFile(join(workspaceRoot, 'CLAUDE.md'), 'No unsafe casts.', 'utf8');
        const trustStore = new ProjectTrustStore({ dataDir: await makeTempWorkspace() });
        await trustStore.setDecision(workspaceRoot, 'trusted');

        const resources = await loadTrustedProjectInstructionResources(workspaceRoot, trustStore);

        const agents = resources.find((resource) => resource.path === 'AGENTS.md');
        const claude = resources.find((resource) => resource.path === 'CLAUDE.md');
        expect(agents?.content).toBe('Always use pnpm.');
        expect(claude?.content).toBe('No unsafe casts.');
        // ProjectInstructionResource carries only { path, content } — no truncated flag.
        for (const resource of resources) {
            expect(Object.keys(resource).sort()).toEqual(['content', 'path']);
        }
    });

    it('returns an empty array when no instruction files exist in a trusted workspace', async () => {
        const workspaceRoot = await makeTempWorkspace();
        const trustStore = new ProjectTrustStore({ dataDir: await makeTempWorkspace() });
        await trustStore.setDecision(workspaceRoot, 'trusted');

        const resources = await loadTrustedProjectInstructionResources(workspaceRoot, trustStore);

        expect(resources).toEqual([]);
    });
});
