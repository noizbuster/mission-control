import { createWorkspaceGuard } from '../tools/read-tools-paths.js';
import type { ProjectTrustDecision, ProjectTrustStore } from '../trust/project-trust-store.js';
import { open } from 'node:fs/promises';

export const defaultProjectResourcePaths = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const;

export type ProjectResource = {
    readonly path: string;
    readonly content: string;
    readonly truncated: boolean;
};

export type DeniedProjectResource = {
    readonly path: string;
    readonly reason: string;
};

export type ProjectResourceLoadInput = {
    readonly workspaceRoot: string;
    readonly trustStore: ProjectTrustStore;
    readonly paths?: readonly string[];
    readonly maxBytes?: number;
};

export type ProjectResourceLoadResult =
    | {
          readonly status: 'skipped';
          readonly trustDecision: Exclude<ProjectTrustDecision, 'trusted'>;
          readonly workspaceRoot: string;
          readonly resources: readonly [];
      }
    | {
          readonly status: 'loaded';
          readonly trustDecision: 'trusted';
          readonly workspaceRoot: string;
          readonly resources: readonly ProjectResource[];
          readonly deniedResources: readonly DeniedProjectResource[];
      };

const defaultMaxResourceBytes = 64 * 1024;

export async function loadProjectResources(input: ProjectResourceLoadInput): Promise<ProjectResourceLoadResult> {
    const trust = await input.trustStore.getDecision(input.workspaceRoot);
    if (trust.decision !== 'trusted') {
        return {
            status: 'skipped',
            trustDecision: trust.decision,
            workspaceRoot: trust.workspaceRoot,
            resources: [],
        };
    }

    const guard = await createWorkspaceGuard(trust.workspaceRoot);
    const resources: ProjectResource[] = [];
    const deniedResources: DeniedProjectResource[] = [];
    const loadedAbsolutePaths = new Set<string>();
    const paths = input.paths ?? defaultProjectResourcePaths;
    const maxBytes = input.maxBytes ?? defaultMaxResourceBytes;

    for (const path of paths) {
        try {
            const target = await guard.resolveExisting(path);
            if (!target.stats.isFile()) {
                deniedResources.push({ path, reason: 'not_file' });
                continue;
            }
            if (loadedAbsolutePaths.has(target.absolutePath)) {
                continue;
            }
            loadedAbsolutePaths.add(target.absolutePath);
            resources.push({
                path: target.relativePath,
                content: await readTextPrefix(target.absolutePath, maxBytes),
                truncated: target.stats.size > maxBytes,
            });
        } catch (error: unknown) {
            const reason = errorMessage(error);
            if (!reason.includes('not_found')) {
                deniedResources.push({ path, reason });
            }
        }
    }

    return {
        status: 'loaded',
        trustDecision: 'trusted',
        workspaceRoot: trust.workspaceRoot,
        resources,
        deniedResources,
    };
}

async function readTextPrefix(path: string, bytes: number): Promise<string> {
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const result = await file.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
