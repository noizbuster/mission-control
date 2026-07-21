import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
} from '@mission-control/protocol';
import { projectSessionReplay, type SessionReplayProjection } from '../session-replay';
import { JsonlSessionEventStore } from './jsonl-session-event-store';
import { parseJsonlSessionLog } from './jsonl-session-records';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REPLAY_PARITY_SESSION_ID = 'session_replay_parity';
export const REPLAY_PARITY_CREATED_AT = '2026-06-21T10:00:00.000Z';

export type ReplayParityLedger = {
    readonly label: string;
    append(event: AgentEvent): Promise<void>;
    appendEnvelope(envelope: AgentEventEnvelope): Promise<void>;
    appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void>;
    getReplay(sessionId: string): Promise<SessionReplayProjection>;
    close(): Promise<void>;
};

export class PlannedSqliteReplayLedgerFake implements ReplayParityLedger {
    readonly label = 'planned-sqlite-ledger-fake';
    private readonly envelopes: AgentEventEnvelope[] = [];
    private nextSequence = 0;

    constructor(private readonly sessionId: string) {}

    async append(event: AgentEvent): Promise<void> {
        const parsedEvent = AgentEventSchema.parse(event);
        this.ensureEventSession(parsedEvent);
        const sequence = this.nextSequence;
        await this.appendParsedEnvelope({
            eventId: `event_${sequence}`,
            sequence,
            createdAt: REPLAY_PARITY_CREATED_AT,
            sessionId: this.sessionId,
            durability: 'durable',
            event: parsedEvent,
        });
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.appendParsedEnvelope(parsedEnvelope);
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.appendParsedEnvelope({
            ...parsedEnvelope,
            sequence: this.nextSequence,
        });
    }

    async getReplay(sessionId: string): Promise<SessionReplayProjection> {
        return projectSessionReplay({ sessionId, envelopes: this.envelopes });
    }

    async close(): Promise<void> {}

    private async appendParsedEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        this.ensureEnvelopeSession(envelope);
        if (envelope.sequence !== this.nextSequence) {
            throw new ReplayParityLedgerError('invalid_sequence', this.sessionId);
        }
        this.envelopes.push(envelope);
        this.nextSequence = envelope.sequence + 1;
    }

    private ensureEventSession(event: AgentEvent): void {
        if (event.sessionId !== this.sessionId) {
            throw new ReplayParityLedgerError('session_mismatch', this.sessionId);
        }
    }

    private ensureEnvelopeSession(envelope: AgentEventEnvelope): void {
        if (envelope.sessionId !== this.sessionId || envelope.event.sessionId !== this.sessionId) {
            throw new ReplayParityLedgerError('session_mismatch', this.sessionId);
        }
    }
}

export class ReplayParityLedgerError extends Error {
    readonly code: 'invalid_sequence' | 'session_mismatch';
    readonly sessionId: string;

    constructor(code: ReplayParityLedgerError['code'], sessionId: string) {
        super(`Replay parity ledger ${sessionId} failed with ${code}`);
        this.name = 'ReplayParityLedgerError';
        this.code = code;
        this.sessionId = sessionId;
    }
}

export async function openJsonlReplayParityLedger(input: {
    readonly dataDir: string;
    readonly sessionId: string;
}): Promise<ReplayParityLedger> {
    const store = await JsonlSessionEventStore.open({
        dataDir: input.dataDir,
        sessionId: input.sessionId,
        now: () => REPLAY_PARITY_CREATED_AT,
        createEventId: (_event, sequence) => `event_${sequence}`,
    });

    return {
        label: 'jsonl-session-event-store',
        append: (event) => store.append(event),
        appendEnvelope: (envelope) => store.appendEnvelope(envelope),
        appendEnvelopeWithStoreSequence: (envelope) => store.appendEnvelopeWithStoreSequence(envelope),
        getReplay: async (sessionId) => {
            await store.getEvents(sessionId);
            const contents = await readFile(join(input.dataDir, 'sessions', `${input.sessionId}.jsonl`), 'utf8');
            return projectSessionReplay({
                sessionId,
                envelopes: parseJsonlSessionLog({
                    contents,
                    filePath: `${input.sessionId}.jsonl`,
                    sessionId,
                }).envelopes,
            });
        },
        close: () => store.close(),
    };
}
