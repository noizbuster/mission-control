import { type WorkflowSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, vi } from 'vitest';
import { missionControlDataDirEnvKey } from '../../memory/data-dir.js';
import type { NormalizedMissionRunStoreLocation } from './mission-run-store-location.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
});

export function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'mission-run-test-'));
    tempRoots.push(root);
    vi.stubEnv(missionControlDataDirEnvKey, root);
    return root;
}

export function seedOmoRoot(root: string): NormalizedMissionRunStoreLocation {
    const dataDir = join(root, 'data');
    mkdirSync(join(root, '.omo'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    return { omoRoot: root, dataDir };
}

export function makeMissionRunTestLocation(): NormalizedMissionRunStoreLocation {
    const root = makeTempRoot();
    const projectRoot = join(root, 'project');
    mkdirSync(join(projectRoot, '.omo'), { recursive: true });
    return { omoRoot: projectRoot, dataDir: join(root, 'data') };
}

export function makeTestWorkflowSpec(): WorkflowSpec {
    return WorkflowSpecSchema.parse({
        name: 'test-workflow',
        description: 'A test workflow',
        graph: {
            id: 'test-graph',
            entryNodeId: 'start',
            nodes: [{ id: 'start', kind: 'llm', label: 'Start' }],
        },
    });
}

export function makeCategorizedWorkflowSpec(): WorkflowSpec {
    return WorkflowSpecSchema.parse({
        name: 'categorized-workflow',
        graph: {
            id: 'cat-graph',
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
        },
        categories: [{ id: 'quick', permissions: ['read', 'edit'] }],
        modes: [{ id: 'autopilot', policies: [] }],
    });
}
