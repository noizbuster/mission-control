import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { DesktopApprovalEffect } from '../desktop-approval-effect.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { openEnsuredLocalSessionDatabase } from './local-session-store-database.js';
import { parseLocalSessionId } from './local-session-store-paths.js';
import type { MemoryStore } from './memory-store.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';

export type LocalSessionEventStore = MemoryStore & {
    readonly sessionId: string;
    appendEnvelope(envelope: AgentEventEnvelope): Promise<void>;
    appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void>;
    reserveDesktopApprovalEffect?(effect: DesktopApprovalEffect): Promise<boolean>;
    claimDesktopApprovalEffect?(effect: DesktopApprovalEffect): Promise<boolean>;
    close(): Promise<void> | void;
};

export type OpenLocalSessionEventStoreOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
};

export async function openLocalSessionEventStore(
    options: OpenLocalSessionEventStoreOptions,
): Promise<SqliteSessionEventStore> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    const sessionId = parseLocalSessionId(options.sessionId);
    const now = options.now ?? (() => new Date().toISOString());
    const { runtime } = await openEnsuredLocalSessionDatabase({ dataDir, now });
    try {
        return SqliteSessionEventStore.fromRuntime(runtime, {
            sessionId,
            now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
        });
    } catch (error: unknown) {
        runtime.close();
        throw error;
    }
}
