import { describe, expect, it } from 'vitest';
import { ProjectTrustStore } from '../trust/project-trust-store.js';
import { loadProjectContextMessages } from './project-context-messages.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadProjectContextMessages', () => {
    it('makes trusted project resources model-visible and skips unknown resources', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-context-data-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-context-workspace-'));
        try {
            await writeFile(join(workspaceRoot, 'AGENTS.md'), 'TRUSTED_MODEL_CONTEXT', 'utf8');
            const trustStore = new ProjectTrustStore({ dataDir, now: fixedNow });

            // When
            const unknown = await loadProjectContextMessages({ workspaceRoot, trustStore });
            await trustStore.setDecision(workspaceRoot, 'trusted');
            const trusted = await loadProjectContextMessages({ workspaceRoot, trustStore });

            // Then
            expect(unknown).toEqual([]);
            expect(trusted).toEqual([
                {
                    role: 'system',
                    content: expect.stringContaining('TRUSTED_MODEL_CONTEXT'),
                },
            ]);
        } finally {
            await Promise.all([
                rm(dataDir, { recursive: true, force: true }),
                rm(workspaceRoot, { recursive: true, force: true }),
            ]);
        }
    });
});

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}
