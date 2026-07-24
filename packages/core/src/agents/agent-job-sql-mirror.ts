import type { Client } from '@libsql/client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import type { SessionBackgroundJob, SessionPendingWait } from '../memory/session-status-derivation';
import { resolveAskUserInputWait, startAskUserInputWait } from '../tools/ask-user-wait-sql';
import {
    activeJobStatuses,
    backgroundJobFrom,
    cancelRecoveredJob,
    selectJobColumns,
} from './agent-job-sql-mirror-handles';
import {
    recordJobWithLifecycle,
    resolveSubagentWaitWithJob,
    startSubagentWaitWithJob,
} from './agent-job-sql-mirror-lifecycle';
import { upsertRuntimeAgentRow } from './agent-job-sql-mirror-persist';
import { parseAgentRef, parseJob, parsePendingWait } from './agent-job-sql-mirror-rows';
import { initializeAgentJobSchema } from './agent-job-sql-mirror-sql';
import type {
    AgentJobRecoveryReport,
    ResolveSubagentWaitInput,
    StartSubagentWaitInput,
} from './agent-job-sql-mirror-types';
import type { BackgroundJobHandle, DurableBackgroundJobHandle } from './async-job-manager';
import type { AgentRef, RuntimeAgentPersistenceMirror } from './runtime-registry';
import type { TaskToolSubagentMirror } from './task-tool-runtime-types';

export type { AgentJobRecoveryReport, ResolveSubagentWaitInput, StartSubagentWaitInput };

export class SqlAgentJobMirror implements RuntimeAgentPersistenceMirror, TaskToolSubagentMirror {
    private pending: Promise<void> = Promise.resolve();
    private pendingError: Error | undefined;

    private constructor(
        readonly client: Client,
        private readonly writeTarget: LocalLibsqlWriteTarget | undefined,
    ) {}

    static async create(input: LocalLibsqlWriteTarget): Promise<SqlAgentJobMirror> {
        await runLocalLibsqlWrite(input, initializeAgentJobSchema);
        return new SqlAgentJobMirror(input.client, input);
    }

    static async createForTests(client: Client): Promise<SqlAgentJobMirror> {
        await initializeAgentJobSchema(client);
        return new SqlAgentJobMirror(client, undefined);
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

    recordJob(handle: DurableBackgroundJobHandle, client?: Client): void | Promise<void> {
        if (client !== undefined) return recordJobWithLifecycle(client, handle);
        this.enqueue(() => this.writeTransaction((client) => recordJobWithLifecycle(client, handle)));
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
        await this.writeTransaction((client) => startSubagentWaitWithJob(client, input, now));
    }

    async resolveSubagentWait(input: ResolveSubagentWaitInput, client?: Client): Promise<void> {
        const now = new Date().toISOString();
        if (client !== undefined) {
            await resolveSubagentWaitWithJob(client, input, now);
            return;
        }
        await this.writeTransaction((client) => resolveSubagentWaitWithJob(client, input, now));
    }

    async startUserInputWait(input: { readonly sessionId: string; readonly toolCallId: string }): Promise<void> {
        await this.writeTransaction((client) =>
            startAskUserInputWait({ client, sessionId: input.sessionId, toolCallId: input.toolCallId }),
        );
    }

    async resolveUserInputWait(input: { readonly sessionId: string; readonly toolCallId: string }): Promise<void> {
        await this.writeTransaction((client) =>
            resolveAskUserInputWait({ client, sessionId: input.sessionId, toolCallId: input.toolCallId }),
        );
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

    private async write<T>(operation: (client: Client) => Promise<T>): Promise<T> {
        if (this.writeTarget === undefined) {
            return operation(this.client);
        }
        return runLocalLibsqlWrite(this.writeTarget, operation);
    }

    private async writeTransaction<T>(operation: (client: Client) => Promise<T>): Promise<T> {
        return this.write((client) => runLocalLibsqlClientTransaction(client, () => operation(client)));
    }
}
