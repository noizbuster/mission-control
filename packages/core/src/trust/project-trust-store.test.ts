import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTrustStore } from './project-trust-store.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ProjectTrustStore', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('persists trusted denied and pending-review decisions by real workspace root', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const trustedWorkspace = await tempRoot('mctrl-trusted-workspace-');
        const deniedWorkspace = await tempRoot('mctrl-denied-workspace-');
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });

        // When
        const trusted = await store.setDecision(trustedWorkspace, 'trusted');
        const denied = await store.setDecision(deniedWorkspace, 'denied');
        const pendingReview = await store.getDecision(await tempRoot('mctrl-review-pending-workspace-'));

        // Then
        expect(trusted.decision).toBe('trusted');
        expect(denied.decision).toBe('denied');
        expect(pendingReview.decision).toBe('unknown');
        expect(await store.getDecision(trustedWorkspace)).toMatchObject({ decision: 'trusted' });
        expect(await store.getDecision(deniedWorkspace)).toMatchObject({ decision: 'denied' });
        expect(await readFile(store.filePath, 'utf8')).toContain(trusted.workspaceRoot);
    });

    it('returns the pending-review decision for stored and corrupt trust files', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspace = await tempRoot('mctrl-trust-workspace-');
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });
        await mkdir(join(dataDir, 'trust'), { recursive: true });
        await writeFile(
            store.filePath,
            JSON.stringify({
                version: 1,
                workspaces: {
                    [workspace]: { status: 'unknown', updatedAt: fixedNow() },
                },
            }),
            'utf8',
        );

        // When
        const explicitUnknown = await store.getDecision(workspace);
        await writeFile(store.filePath, '{"version":1,"workspaces":{"bad":{"status":"allow"}}}', 'utf8');
        const invalidStatus = await store.getDecision(workspace);
        await writeFile(store.filePath, '{"version":', 'utf8');
        const corruptJson = await store.getDecision(workspace);

        // Then
        expect(explicitUnknown).toMatchObject({ decision: 'unknown', storeState: 'valid' });
        expect(invalidStatus).toMatchObject({ decision: 'unknown', storeState: 'corrupt' });
        expect(corruptJson).toMatchObject({ decision: 'unknown', storeState: 'corrupt' });
    });

    it('does not overwrite a corrupt trust file when setting a decision', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspace = await tempRoot('mctrl-trust-workspace-');
        const store = new ProjectTrustStore({ dataDir, now: fixedNow });
        await mkdir(join(dataDir, 'trust'), { recursive: true });
        const corruptContents = '{"version":';
        await writeFile(store.filePath, corruptContents, 'utf8');

        // When / Then
        await expect(store.setDecision(workspace, 'trusted')).rejects.toMatchObject({ code: 'corrupt_store' });
        expect(await readFile(store.filePath, 'utf8')).toBe(corruptContents);
    });

    it('serializes concurrent writes without losing workspace records', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const firstWorkspace = await tempRoot('mctrl-trust-first-');
        const secondWorkspace = await tempRoot('mctrl-trust-second-');

        // When
        await Promise.all([
            new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(firstWorkspace, 'trusted'),
            new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(secondWorkspace, 'denied'),
        ]);

        // Then
        const verifier = new ProjectTrustStore({ dataDir, now: fixedNow });
        expect(await verifier.getDecision(firstWorkspace)).toMatchObject({ decision: 'trusted' });
        expect(await verifier.getDecision(secondWorkspace)).toMatchObject({ decision: 'denied' });
    });

    async function tempRoot(prefix: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        return root;
    }
});

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}
