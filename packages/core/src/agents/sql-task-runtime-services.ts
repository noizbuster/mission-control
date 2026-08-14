import type { LocalLibsqlDb } from '../db/local-libsql-db';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db';
import { SessionControlHost } from '../runtime/session-control-host';
import { type AgentJobRecoveryReport, SqlAgentJobMirror } from './agent-job-sql-mirror';
import { AsyncJobManager, type BackgroundJobHandle } from './async-job-manager';
import { AgentLifecycleManager } from './lifecycle-manager';
import { RuntimeAgentRegistry } from './runtime-registry';
import type { TaskToolRuntimeServices } from './task-tool-runtime';

export type SqlTaskRuntimeServicesOptions = {
    readonly maxConcurrency?: number;
    readonly recoverActiveJobs?: boolean;
    readonly observabilityRedactor?: ObservabilityRedactor | Promise<ObservabilityRedactor>;
    /** Forwarded to the AsyncJobManager's best-effort terminal listener. */
    readonly onTerminalJob?: (handle: BackgroundJobHandle) => void;
};

export type SqlTaskRuntimeServices = TaskToolRuntimeServices & {
    readonly sessionControlHost: SessionControlHost;
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
    const canonicalDataDir = dataDir ?? resolveMissionControlDataDir();
    const { identity, runtime } = await openCanonicalRuntimeDb({
        dataDir: canonicalDataDir,
    });
    try {
        const mirror = await SqlAgentJobMirror.create(runtime);
        if (options.recoverActiveJobs ?? true) {
            await mirror.recoverJobs();
        }
        const runtimeRegistry = new RuntimeAgentRegistry({ mirror, initialRefs: await mirror.loadRuntimeAgents() });
        const sessionControlHost = new SessionControlHost({
            runtime,
            dbIdentity: identity.dbIdentity,
            dataDir: canonicalDataDir,
            ...(options.observabilityRedactor !== undefined
                ? { observabilityRedactor: options.observabilityRedactor }
                : {}),
        });
        const jobManager = new AsyncJobManager(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, {
            mirror,
            sessionControlHost,
            ...(options.onTerminalJob !== undefined ? { onTerminal: options.onTerminalJob } : {}),
        });
        const lifecycleManager = new AgentLifecycleManager(runtimeRegistry);
        return createServicesHandle({
            runtime,
            mirror,
            runtimeRegistry,
            jobManager,
            lifecycleManager,
            sessionControlHost,
        });
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
    readonly sessionControlHost: SessionControlHost;
}): SqlTaskRuntimeServices {
    let closed = false;
    return {
        jobManager: input.jobManager,
        lifecycleManager: input.lifecycleManager,
        runtimeRegistry: input.runtimeRegistry,
        sessionControlHost: input.sessionControlHost,
        mirror: input.mirror,
        flush: () => input.mirror.flush(),
        recoverJobs: () => input.mirror.recoverJobs(),
        close: async () => {
            if (closed) return;
            closed = true;
            await input.jobManager.drain();
            await input.mirror.flush();
            await input.sessionControlHost.close();
            input.runtime.close();
        },
    };
}
