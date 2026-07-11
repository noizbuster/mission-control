import type { SessionStopScope } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { openCanonicalRuntimeDb } from './local-runtime-db.js';
import { createPlatformSessionOwnerControlClient } from './session-owner-control-client.js';
import { type SessionStopTreeResult, stopSessionTree } from './session-stop-tree.js';

export type StopLocalSessionTreeInput = {
    readonly targetSessionId: string;
    readonly scope: SessionStopScope;
    readonly requestId: string;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly dataDir?: string;
};

export async function stopLocalSessionTree(input: StopLocalSessionTreeInput): Promise<SessionStopTreeResult> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { identity, runtime } = await openCanonicalRuntimeDb({
        dataDir,
        legacyRoots: [dataDir],
        sessionControlMaintenance: false,
    });
    try {
        return await stopSessionTree({
            targetSessionId: input.targetSessionId,
            scope: input.scope,
            requestId: input.requestId,
            operationId: input.operationId,
            timeoutMs: input.timeoutMs,
            client: runtime.client,
            createClient: (sessionId) =>
                createPlatformSessionOwnerControlClient({
                    runtime,
                    dbIdentity: identity.dbIdentity,
                    sessionId,
                }),
        });
    } finally {
        runtime.close();
    }
}
