import {
    type AbgGraphSnapshot,
    type AgentEvent,
    type AgentEventEnvelope,
    type AgentSnapshot,
    type ToolCall,
} from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { openMissionControlDb } from '../db/mission-control-db.js';
import type {
    DesktopApprovalEffect,
    DesktopApprovalEffectClaimInput,
    DesktopApprovalEffectClaimResult,
    DesktopApprovalEffectRecord,
    DesktopApprovalEffectResolutionInput,
    DesktopApprovalEffectSettlementInput,
} from '../desktop-approval-effect.js';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor.js';
import { projectSessionReplay, type SessionReplayProjection } from '../session-replay.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { defaultSession, deriveSession } from './jsonl-session-projection.js';
import type { MemoryStore, SessionCompactionRecordInput } from './memory-store.js';
import { createSessionCompactionEvent } from './session-compaction-event.js';
import {
    claimSqliteDesktopApprovalEffect,
    readSqliteDesktopApprovalEffect,
    recoverExpiredSqliteDesktopApprovalEffects,
    reserveSqliteDesktopApprovalEffect,
    resolveSqliteDesktopApprovalEffect,
    settleSqliteDesktopApprovalEffect,
} from './sqlite-session-approval-effects.js';
import { readSqliteDesktopToolProposal } from './sqlite-session-desktop-tool-proposals.js';
import { SqliteSessionEventAppender } from './sqlite-session-event-appender.js';
import { SqliteSessionEventStoreError } from './sqlite-session-event-store-errors.js';
import { readSqliteSessionEnvelopes } from './sqlite-session-event-store-read.js';
import { logFromEvents } from './sqlite-session-event-store-rows.js';
import { ensureSqliteSessionRows } from './sqlite-session-event-store-sql.js';
import { runSqliteSessionWriteTransaction } from './sqlite-session-event-store-transaction.js';
import { randomUUID } from 'node:crypto';

export { SqliteSessionEventStoreError };

export type SqliteSessionEventStoreOpenOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export type SqliteSessionEventStoreRuntimeOptions = Omit<SqliteSessionEventStoreOpenOptions, 'dataDir'>;

export class SqliteSessionEventStore implements MemoryStore {
    readonly sessionId: string;
    private readonly runtime: LocalLibsqlDb;
    private readonly now: () => string;
    private readonly createEventId: JsonlSessionEventIdFactory;
    private readonly observabilityRedactor: ObservabilityRedactor;
    private readonly eventAppender: SqliteSessionEventAppender;
    private appendQueue: Promise<void> = Promise.resolve();
    private closed = false;

    private constructor(input: {
        readonly runtime: LocalLibsqlDb;
        readonly sessionId: string;
        readonly now: () => string;
        readonly createEventId: JsonlSessionEventIdFactory;
        readonly observabilityRedactor: ObservabilityRedactor;
    }) {
        this.runtime = input.runtime;
        this.sessionId = input.sessionId;
        this.now = input.now;
        this.createEventId = input.createEventId;
        this.observabilityRedactor = input.observabilityRedactor;
        this.eventAppender = new SqliteSessionEventAppender({
            runtime: this.runtime,
            sessionId: this.sessionId,
            now: this.now,
            createEventId: this.createEventId,
            observabilityRedactor: this.observabilityRedactor,
            enqueueWrite: <Result>(write: () => Promise<Result>) => this.enqueueAppend(write),
        });
    }

    static async open(options: SqliteSessionEventStoreOpenOptions): Promise<SqliteSessionEventStore> {
        const runtime = await openMissionControlDb({
            ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
        });
        try {
            const store = SqliteSessionEventStore.fromRuntime(runtime, options);
            await store.recoverExpiredDesktopApprovalEffects();
            return store;
        } catch (error: unknown) {
            runtime.close();
            throw error;
        }
    }

    static fromRuntime(
        runtime: LocalLibsqlDb,
        options: SqliteSessionEventStoreRuntimeOptions,
    ): SqliteSessionEventStore {
        return new SqliteSessionEventStore({
            runtime,
            sessionId: options.sessionId,
            now: options.now ?? (() => new Date().toISOString()),
            createEventId: options.createEventId ?? (() => randomUUID()),
            observabilityRedactor: options.observabilityRedactor ?? createObservabilityRedactor(),
        });
    }

    async append(event: AgentEvent): Promise<void> {
        await this.eventAppender.append(event);
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        await this.eventAppender.appendEnvelope(envelope);
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        await this.eventAppender.appendEnvelopeWithStoreSequence(envelope);
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        return (await this.readEnvelopes(sessionId)).map((envelope) => envelope.event);
    }

    async getReplay(sessionId: string): Promise<SessionReplayProjection> {
        return projectSessionReplay({ sessionId, envelopes: await this.readEnvelopes(sessionId) });
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        const events = await this.getEvents(sessionId);
        const log = logFromEvents(events);
        return log.getSnapshot(events.length === 0 ? defaultSession(sessionId) : deriveSession(sessionId, events));
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        return logFromEvents(await this.getEvents(sessionId)).getGraphSnapshot(graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        return logFromEvents(await this.getEvents(sessionId)).getTimeline();
    }

    async compact(input: SessionCompactionRecordInput): Promise<AgentEvent> {
        const event = createSessionCompactionEvent(input);
        await this.append(event);
        return event;
    }

    async reserveDesktopApprovalEffect(effect: DesktopApprovalEffect): Promise<boolean> {
        this.assertEffectSession(effect);
        return this.enqueueAppend(async () => {
            await this.ensureSessionRowsInOpenTransaction(this.now());
            return reserveSqliteDesktopApprovalEffect(this.runtime.client, effect, this.now());
        });
    }

    async claimDesktopApprovalEffect(
        input: DesktopApprovalEffectClaimInput,
    ): Promise<DesktopApprovalEffectClaimResult> {
        this.assertEffectSession(input.effect);
        return this.enqueueAppend(async () => {
            await this.ensureSessionRowsInOpenTransaction(this.now());
            return claimSqliteDesktopApprovalEffect(this.runtime.client, input, this.now());
        });
    }

    async settleDesktopApprovalEffect(input: DesktopApprovalEffectSettlementInput): Promise<boolean> {
        this.assertEffectSession(input.effect);
        return this.enqueueAppend(() => settleSqliteDesktopApprovalEffect(this.runtime.client, input, this.now()));
    }

    async getDesktopApprovalEffect(approvalId: string): Promise<DesktopApprovalEffectRecord | undefined> {
        await this.appendQueue;
        this.ensureOpen();
        return readSqliteDesktopApprovalEffect(this.runtime.client, this.sessionId, approvalId);
    }

    async getDesktopApprovalToolCall(toolCallId: string): Promise<ToolCall | undefined> {
        await this.appendQueue;
        this.ensureOpen();
        return readSqliteDesktopToolProposal(this.runtime.client, this.sessionId, toolCallId);
    }

    async resolveDesktopApprovalEffect(
        input: DesktopApprovalEffectResolutionInput,
    ): Promise<DesktopApprovalEffectRecord | undefined> {
        return this.enqueueAppend(() => resolveSqliteDesktopApprovalEffect(this.runtime.client, this.sessionId, input));
    }

    async recoverExpiredDesktopApprovalEffects(): Promise<number> {
        return this.enqueueAppend(() => recoverExpiredSqliteDesktopApprovalEffects(this.runtime.client, this.now()));
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        await this.appendQueue;
        this.closed = true;
        this.runtime.close();
    }

    private enqueueAppend<Result>(write: () => Promise<Result>): Promise<Result> {
        const queued = this.appendQueue.then(() => this.withWriteTransaction(write));
        this.appendQueue = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }

    private assertEffectSession(effect: DesktopApprovalEffect): void {
        if (effect.sessionId !== this.sessionId) {
            throw new TypeError('desktop approval effect session does not match the store session');
        }
    }

    private async ensureSessionRowsInOpenTransaction(createdAt: string): Promise<void> {
        await ensureSqliteSessionRows({ client: this.runtime.client, sessionId: this.sessionId, createdAt });
    }

    private async readEnvelopes(sessionId: string): Promise<readonly AgentEventEnvelope[]> {
        await this.appendQueue;
        this.ensureOpen();
        return this.readEnvelopesBySessionId(sessionId);
    }

    private async readEnvelopesBySessionId(sessionId: string): Promise<readonly AgentEventEnvelope[]> {
        return (await readSqliteSessionEnvelopes({ client: this.runtime.client, sessionId })).map((envelope) =>
            redactAgentEventEnvelopeForObservability(envelope, this.observabilityRedactor),
        );
    }

    private ensureOpen(): void {
        if (this.closed) {
            throw new SqliteSessionEventStoreError({
                code: 'write_failed',
                sessionId: this.sessionId,
                message: `SQLite session store ${this.sessionId} is already closed`,
            });
        }
    }

    private async withWriteTransaction<T>(write: () => Promise<T>): Promise<T> {
        return runSqliteSessionWriteTransaction({ runtime: this.runtime, ensureOpen: () => this.ensureOpen(), write });
    }
}
