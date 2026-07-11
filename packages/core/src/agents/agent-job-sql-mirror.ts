import type { Client } from '@libsql/client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction.js';
import type { SessionBackgroundJob, SessionPendingWait } from '../memory/session-status-derivation.js';
import {
    activeJobStatuses,
    backgroundJobFrom,
    cancelRecoveredJob,
    selectJobColumns,
} from './agent-job-sql-mirror-handles.js';
import {
    recordJobWithLifecycle,
    resolveSubagentWaitWithJob,
    startSubagentWaitWithJob,
} from './agent-job-sql-mirror-lifecycle.js';
import { upsertRuntimeAgentRow } from './agent-job-sql-mirror-persist.js';
import { parseAgentRef, parseJob, parsePendingWait } from './agent-job-sql-mirror-rows.js';
import { initializeAgentJobSchema } from './agent-job-sql-mirror-sql.js';
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

    recordJob(handle: BackgroundJobHandle, client?: Client): void | Promise<void> {
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

function isLocalLibsqlWriteTarget(input: Client | LocalLibsqlWriteTarget): input is LocalLibsqlWriteTarget {
    return 'url' in input && 'client' in input;
}
