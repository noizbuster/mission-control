import type { ReplayDiagnostic } from '@mission-control/core';
import { projectJsonlSessionReplayPrefix } from '@mission-control/core';

export type SessionCatalogProjection = {
    readonly status: 'corrupt' | 'idle' | 'running' | 'stopped' | 'failed';
    readonly eventCount: number;
    readonly updatedAt?: string;
    readonly createdAt?: string;
    readonly cwd?: string;
    readonly trustedRoot?: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly name?: string;
    readonly messageCount: number;
    readonly activeLeafId?: string;
    readonly parentSessionId?: string;
    readonly diagnostics: readonly ReplayDiagnostic[];
};

export function deriveSessionCatalogProjection(input: {
    readonly sessionId: string;
    readonly contents: string;
}): SessionCatalogProjection {
    const replay = projectJsonlSessionReplayPrefix(input);
    const lastEvent = replay.projection.events.at(-1);
    const createdAt = headerCreatedAt(input.contents);
    const cwd = treeString(replay.projection.sessionTree, 'cwd');
    const trustedRoot = treeString(replay.projection.sessionTree, 'trustedRoot');
    const workspaceTrust = treeTrust(replay.projection.sessionTree);
    return {
        status: replay.diagnostics.length > 0 ? 'corrupt' : replay.projection.snapshot.status,
        eventCount: replay.projection.events.length,
        messageCount: replay.projection.events.filter((event) => event.message !== undefined).length,
        diagnostics: replay.diagnostics,
        ...(lastEvent?.timestamp !== undefined ? { updatedAt: lastEvent.timestamp } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(trustedRoot !== undefined ? { trustedRoot } : {}),
        ...(workspaceTrust !== undefined ? { workspaceTrust } : {}),
        ...(replay.projection.sessionTree.sessionName !== undefined
            ? { name: replay.projection.sessionTree.sessionName }
            : {}),
        ...(replay.projection.sessionTree.activeLeafId !== undefined
            ? { activeLeafId: replay.projection.sessionTree.activeLeafId }
            : {}),
        ...(replay.projection.sessionTree.parentSessionId !== undefined
            ? { parentSessionId: replay.projection.sessionTree.parentSessionId }
            : {}),
    };
}

function headerCreatedAt(contents: string): string | undefined {
    const firstLine = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    if (firstLine === undefined) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(firstLine);
        return isRecord(parsed) && typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is { readonly createdAt?: unknown } {
    return typeof value === 'object' && value !== null;
}

function treeString(tree: unknown, key: 'cwd' | 'trustedRoot'): string | undefined {
    if (typeof tree !== 'object' || tree === null) {
        return undefined;
    }
    const value = Reflect.get(tree, key);
    return typeof value === 'string' ? value : undefined;
}

function treeTrust(tree: unknown): 'trusted' | 'denied' | 'unknown' | undefined {
    if (typeof tree !== 'object' || tree === null) {
        return undefined;
    }
    const value = Reflect.get(tree, 'workspaceTrust');
    return value === 'trusted' || value === 'denied' || value === 'unknown' ? value : undefined;
}
