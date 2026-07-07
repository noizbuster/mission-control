import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { openRuntimeLocalDb } from '../runtime/local-runtime-db.js';
import { type AgentJobRecoveryReport, SqlAgentJobMirror } from './agent-job-sql-mirror.js';
import { AsyncJobManager } from './async-job-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import { RuntimeAgentRegistry } from './runtime-registry.js';
import type { TaskToolRuntimeServices } from './task-tool-runtime.js';

export type SqlTaskRuntimeServicesOptions = {
    readonly maxConcurrency?: number;
    readonly recoverActiveJobs?: boolean;
};

export type SqlTaskRuntimeServices = TaskToolRuntimeServices & {
    readonly mirror: SqlAgentJobMirror;
    readonly flush: () => Promise<void>;
    readonly recoverJobs: () => Promise<AgentJobRecoveryReport>;
    readonly close: () => Promise<void>;
};

const DEFAULT_MAX_CONCURRENCY = 4;

export async function createSqlTaskRuntimeServices(
    dataDir?: string,
    options: SqlTaskRuntimeServicesOptions = {},
): Promise<SqlTaskRuntimeServices> {
    const runtime = await openRuntimeLocalDb(dataDir);
    try {
        const mirror = await SqlAgentJobMirror.create(runtime);
        if (options.recoverActiveJobs ?? true) {
            await mirror.recoverJobs();
        }
        const runtimeRegistry = new RuntimeAgentRegistry({ mirror, initialRefs: await mirror.loadRuntimeAgents() });
        const jobManager = new AsyncJobManager(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, { mirror });
        const lifecycleManager = new AgentLifecycleManager(runtimeRegistry);
        return createServicesHandle({ runtime, mirror, runtimeRegistry, jobManager, lifecycleManager });
    } catch (error: unknown) {
        runtime.close();
        throw error;
    }
}

function createServicesHandle(input: {
    readonly runtime: LocalLibsqlDb;
    readonly mirror: SqlAgentJobMirror;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly jobManager: AsyncJobManager;
    readonly lifecycleManager: AgentLifecycleManager;
}): SqlTaskRuntimeServices {
    let closed = false;
    return {
        jobManager: input.jobManager,
        lifecycleManager: input.lifecycleManager,
        runtimeRegistry: input.runtimeRegistry,
        mirror: input.mirror,
        flush: () => input.mirror.flush(),
        recoverJobs: () => input.mirror.recoverJobs(),
        close: async () => {
            if (closed) return;
            closed = true;
            await input.mirror.flush();
            input.runtime.close();
        },
    };
}
