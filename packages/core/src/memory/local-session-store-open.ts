import type { AgentEventEnvelope } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from './data-dir.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { ensureLocalSessionDatabase } from './local-session-store-database.js';
import { localSessionDbUrl, parseLocalSessionId } from './local-session-store-paths.js';
import type { MemoryStore } from './memory-store.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';

export type LocalSessionEventStore = MemoryStore & {
    readonly sessionId: string;
    appendEnvelope(envelope: AgentEventEnvelope): Promise<void>;
    appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void>;
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
): Promise<LocalSessionEventStore> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    const sessionId = parseLocalSessionId(options.sessionId);
    const now = options.now ?? (() => new Date().toISOString());
    let store: SqliteSessionEventStore | undefined;
    try {
        await ensureLocalSessionDatabase({ dataDir, now });
        store = await SqliteSessionEventStore.open({
            url: localSessionDbUrl(dataDir),
            sessionId,
            now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
        });
        return store;
    } catch (error: unknown) {
        await store?.close();
        throw error;
    }
}
