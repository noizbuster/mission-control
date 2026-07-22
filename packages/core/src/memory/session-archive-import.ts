import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { resolveMissionControlDataDir } from './data-dir';
import { openLocalSessionEventStore } from './local-session-store-open';

export type ImportSessionEnvelopesResult = 'imported' | 'session_exists';

export async function importSessionEnvelopesToLocalStore(input: {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<ImportSessionEnvelopesResult> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const store = await openLocalSessionEventStore({
        dataDir,
        sessionId: input.sessionId,
        ...(input.observabilityRedactor !== undefined
            ? { observabilityRedactor: input.observabilityRedactor }
            : {}),
    });
    try {
        if ((await store.getEvents(input.sessionId)).length > 0) {
            return 'session_exists';
        }
        for (const envelope of input.envelopes) {
            await store.appendEnvelopeWithStoreSequence(envelope);
        }
        return 'imported';
    } finally {
        await store.close();
    }
}
