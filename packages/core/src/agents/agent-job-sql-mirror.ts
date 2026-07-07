import type { Client } from '@libsql/client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql.js';
import type { SessionBackgroundJob, SessionPendingWait } from '../memory/session-status-derivation.js';
import {
    activeJobStatuses,
    backgroundJobFrom,
    cancelRecoveredJob,
    resolvedSubagentJob,
    selectJobColumns,
} from './agent-job-sql-mirror-handles.js';
import { upsertJobRow, upsertRuntimeAgentRow } from './agent-job-sql-mirror-persist.js';
import { parseAgentRef, parseJob, parsePendingWait } from './agent-job-sql-mirror-rows.js';
import {
    createAgentJobIndexesSql,
    createAsyncJobsSql,
    createPublicSessionsSql,
    createRuntimeAgentsSql,
    createSessionAwaitsSql,
    createSessionRelationsSql,
} from './agent-job-sql-mirror-sql.js';
import type {
    AgentJobRecoveryReport,
    ResolveSubagentWaitInput,
    StartSubagentWaitInput,
} from './agent-job-sql-mirror-types.js';
import type { BackgroundJobHandle } from './async-job-manager.js';
import type { AgentRef, RuntimeAgentPersistenceMirror } from './runtime-registry.js';

export type { AgentJobRecoveryReport, ResolveSubagentWaitInput, StartSubagentWaitInput };

export class SqlAgentJobMirror implements RuntimeAgentPersistenceMirror {
    private pending: Promise<void> = Promise.resolve();
    private pendingError: Error | undefined;

    private constructor(
        readonly client: Client,
        private readonly writeTarget: LocalLibsqlWriteTarget | undefined,
    ) {}

    static async create(input: Client | LocalLibsqlWriteTarget): Promise<SqlAgentJobMirror> {
        if (isLocalLibsqlWriteTarget(input)) {
            await initializeAgentJobSchema(input.client);
            return new SqlAgentJobMirror(input.client, input);
        }
        await initializeAgentJobSchema(input);
        return new SqlAgentJobMirror(input, undefined);
    }

    recordRuntimeAgent(ref: AgentRef): void {
        this.enqueue(() => this.write((client) => upsertRuntimeAgentRow({ client, ref })));
    }

    releaseRuntimeAgent(agentId: string): void {
        this.enqueue(() =>
            this.write((client) =>
                client.execute({ sql: 'DELETE FROM runtime_agents WHERE agent_id = ?', args: [agentId] }),
            ),
        );
    }

    recordJob(handle: BackgroundJobHandle): void {
        this.enqueue(() => this.write((client) => upsertJobRow({ client, handle })));
    }

    async flush(): Promise<void> {
        await this.pending;
        if (this.pendingError !== undefined) {
            const error = this.pendingError;
            this.pendingError = undefined;
            throw error;
        }
    }

    async loadRuntimeAgents(): Promise<readonly AgentRef[]> {
        const result = await this.client.execute(
            'SELECT agent_id, kind, session_id, parent_agent_id, status, activity, created_at, updated_at, metadata_json FROM runtime_agents ORDER BY created_at, agent_id',
        );
        return result.rows.flatMap((row) => {
            const ref = parseAgentRef(row);
            return ref === undefined ? [] : [ref];
        });
    }

    async loadJobs(): Promise<readonly BackgroundJobHandle[]> {
        const result = await this.client.execute(
            `SELECT ${selectJobColumns} FROM async_jobs ORDER BY queued_at, job_id`,
        );
        return result.rows.flatMap((row) => {
            const job = parseJob(row);
            return job === undefined ? [] : [job];
        });
    }

    async recoverJobs(): Promise<AgentJobRecoveryReport> {
        const jobs = await this.loadJobs();
        let cancelled = 0;
        let preserved = 0;
        for (const job of jobs) {
            if (activeJobStatuses.has(job.status)) {
                this.recordJob(cancelRecoveredJob(job));
                cancelled++;
            } else {
                preserved++;
            }
        }
        await this.flush();
        return { recovered: jobs.length, cancelled, preserved };
    }

    async startSubagentWait(input: StartSubagentWaitInput): Promise<void> {
        if (input.mode === 'detached') return;
        const now = new Date().toISOString();
        await this.write(async (client) => {
            await this.insertSubagentWait(client, input, now);
            await persistSessionAwaiting({
                client,
                sessionId: input.parentSessionId,
                reason: 'subagent',
                waitId: input.childSessionId,
                now,
            });
        });
        this.recordJob({
            jobId: input.childSessionId,
            sessionId: input.childSessionId,
            parentSessionId: input.parentSessionId,
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            blocking: true,
            status: 'running',
            startedAt: now,
        });
    }

    async resolveSubagentWait(input: ResolveSubagentWaitInput): Promise<void> {
        const now = new Date().toISOString();
        await this.write(async (client) => {
            await ensurePublicSessionRow({ client, sessionId: input.parentSessionId, now });
            await ensurePublicSessionRow({ client, sessionId: input.childSessionId, now });
            await client.execute({
                sql:
                    'UPDATE session_awaits SET status = ?, resolved_at = ? ' +
                    'WHERE session_id = ? AND child_session_id = ? AND status = ?',
                args: ['resolved', now, input.parentSessionId, input.childSessionId, 'pending'],
            });
            await refreshSessionAwaitingFromPendingWaits({
                client,
                sessionId: input.parentSessionId,
                now,
            });
        });
        this.recordJob(resolvedSubagentJob(input, now));
    }

    async loadPendingWaits(parentSessionId: string): Promise<readonly SessionPendingWait[]> {
        const result = await this.client.execute({
            sql:
                'SELECT wait_id, reason, source_kind, source_id, job_id, child_session_id, metadata_json ' +
                'FROM session_awaits WHERE session_id = ? AND status = ? ORDER BY created_at, wait_id',
            args: [parentSessionId, 'pending'],
        });
        return result.rows.flatMap((row) => {
            const wait = parsePendingWait(row);
            return wait === undefined ? [] : [wait];
        });
    }

    async loadBackgroundJobsForParent(parentSessionId: string): Promise<readonly SessionBackgroundJob[]> {
        const result = await this.client.execute({
            sql: `SELECT ${selectJobColumns} FROM async_jobs WHERE parent_session_id = ? ORDER BY queued_at, job_id`,
            args: [parentSessionId],
        });
        return result.rows.flatMap((row) => {
            const handle = parseJob(row);
            return handle === undefined ? [] : [backgroundJobFrom(handle)];
        });
    }

    private enqueue(operation: () => Promise<unknown>): void {
        const next = this.pending.then(async () => {
            await operation();
        });
        this.pending = next.catch((error: unknown) => {
            this.pendingError = error instanceof Error ? error : new Error(String(error));
        });
    }

    private async insertSubagentWait(client: Client, input: StartSubagentWaitInput, now: string): Promise<void> {
        await ensurePublicSessionRow({ client, sessionId: input.parentSessionId, now });
        await ensurePublicSessionRow({ client, sessionId: input.childSessionId, now });
        await client.execute({
            sql:
                'INSERT OR REPLACE INTO session_awaits ' +
                '(wait_id, session_id, reason, source_kind, source_id, job_id, child_session_id, status, created_at, metadata_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [
                input.childSessionId,
                input.parentSessionId,
                'subagent',
                'child_session',
                input.childSessionId,
                input.childSessionId,
                input.childSessionId,
                'pending',
                now,
                JSON.stringify({ mode: input.mode }),
            ],
        });
        await client.execute({
            sql:
                'INSERT INTO session_relations ' +
                '(relation_id, parent_session_id, child_session_id, kind, created_at, metadata_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(parent_session_id, child_session_id, kind) DO UPDATE SET created_at = excluded.created_at, ' +
                'metadata_json = excluded.metadata_json',
            args: [
                relationId(input.parentSessionId, input.childSessionId, 'subagent'),
                input.parentSessionId,
                input.childSessionId,
                'subagent',
                now,
                JSON.stringify({ agentId: input.agentId ?? null, mode: input.mode }),
            ],
        });
    }

    private async write<T>(operation: (client: Client) => Promise<T>): Promise<T> {
        if (this.writeTarget === undefined) {
            return operation(this.client);
        }
        return runLocalLibsqlWrite(this.writeTarget, operation);
    }
}

function relationId(parentSessionId: string, childSessionId: string, kind: string): string {
    return `${parentSessionId}:${childSessionId}:${kind}`;
}

async function initializeAgentJobSchema(client: Client): Promise<void> {
    await client.execute(createPublicSessionsSql);
    await client.execute(createRuntimeAgentsSql);
    await client.execute(createAsyncJobsSql);
    await client.execute(createSessionAwaitsSql);
    await client.execute(createSessionRelationsSql);
    for (const statement of createAgentJobIndexesSql) await client.execute(statement);
}

function isLocalLibsqlWriteTarget(input: Client | LocalLibsqlWriteTarget): input is LocalLibsqlWriteTarget {
    return 'url' in input && 'client' in input;
}
