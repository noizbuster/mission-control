import { JsonlSessionEventStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';

export type RunEventRecorder = {
    readonly record: (event: AgentEvent) => AgentEvent;
    readonly close: () => Promise<void>;
    readonly sessionId?: string;
    readonly store?: JsonlSessionEventStore;
};

export async function createRunEventRecorder(args: CliArgs): Promise<RunEventRecorder> {
    const sessionId = args.sessionId ?? (args.mode === 'jsonl' ? createSessionId() : undefined);
    if (sessionId === undefined) {
        return {
            record: (event) => event,
            close: async () => {},
        };
    }

    const store = await JsonlSessionEventStore.open({ sessionId });
    const appendPromises: Promise<void>[] = [];
    return {
        record: (event) => {
            const mapped = { ...event, sessionId };
            appendPromises.push(store.append(mapped));
            return mapped;
        },
        close: async () => {
            try {
                await Promise.all(appendPromises);
            } finally {
                await store.close();
            }
        },
        sessionId,
        store,
    };
}

function createSessionId(): string {
    return `session_${Date.now()}`;
}
