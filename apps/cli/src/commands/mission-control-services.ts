/**
 * MissionControlServices - CLI-owned session owner of the runtime managers.
 *
 * One interactive session and one noninteractive run each constructs a single
 * {@link MissionControlServices} and reuses it for every tool call, instead of
 * spinning up a fresh `AsyncJobManager` / `AgentLifecycleManager` /
 * `RuntimeAgentRegistry` per invocation. {@link getOrCreateMissionControlServices}
 * lazily builds and caches one instance per resolved workspace root so the whole
 * session shares the same manager instances.
 *
 * This owns state only. Wiring the managers into the task tool runtime is a
 * separate concern (todo 7).
 */

import {
    type AgentLifecycleManager,
    type AgentStatus,
    type AsyncJobManager,
    type BackgroundJobHandle,
    createSqlTaskRuntimeServices,
    MAIN_AGENT_ID,
    type RuntimeAgentRegistry,
    resolveMissionControlDataDir,
    resolveOmoRoot,
    type SqlTaskRuntimeServices,
    type TaskToolRuntimeServices,
} from '@mission-control/core';
import { resolve } from 'node:path';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_IDLE_TTL_MS = 420_000;

export interface MissionControlServicesOptions {
    /** Concurrency cap for {@link AsyncJobManager}. Defaults to 4. */
    readonly maxConcurrency?: number;
    /**
     * Default idle TTL surfaced to callers that adopt subagents through the
     * lifecycle manager. The manager itself applies TTL per-adopt, so this is
     * the session-wide default a caller threads into `adopt`.
     */
    readonly defaultIdleTtlMs?: number;
}

export interface JobStatsSnapshot {
    readonly activeCount: number;
    readonly total: number;
    readonly byStatus: Readonly<Record<BackgroundJobHandle['status'], number>>;
}

export interface AgentStatsSnapshot {
    readonly visibleCount: number;
    readonly byStatus: Readonly<Record<AgentStatus, number>>;
}

export interface MissionControlServicesSnapshot {
    readonly omoRoot: string;
    readonly maxConcurrency: number;
    readonly defaultIdleTtlMs: number;
    readonly disposed: boolean;
    readonly jobs: JobStatsSnapshot;
    readonly agents: AgentStatsSnapshot;
}

/**
 * Construct and own the three runtime managers plus the resolved `.omo` root
 * for a single CLI session. Use {@link MissionControlServices.create} (or the
 * {@link getOrCreateMissionControlServices} factory) to resolve the omo root
 * from a workspace; the private constructor takes an already-resolved root so
 * tests can build an instance without touching disk.
 */
export class MissionControlServices {
    private readonly sqlServices: SqlTaskRuntimeServices;
    private readonly omoRoot: string;
    private readonly maxConcurrency: number;
    private readonly defaultIdleTtlMs: number;
    private disposed = false;

    private constructor(omoRoot: string, options: MissionControlServicesOptions, sqlServices: SqlTaskRuntimeServices) {
        this.omoRoot = omoRoot;
        this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
        this.defaultIdleTtlMs = options.defaultIdleTtlMs ?? DEFAULT_IDLE_TTL_MS;
        this.sqlServices = sqlServices;
    }

    /** Resolve the `.omo` root from `workspaceRoot`, then construct. */
    static async create(
        workspaceRoot: string,
        options?: MissionControlServicesOptions,
    ): Promise<MissionControlServices> {
        const omoRoot = await resolveOmoRoot(workspaceRoot);
        const resolvedOptions = options ?? {};
        const sqlServices = await createSqlTaskRuntimeServices(resolveMissionControlDataDir(), {
            maxConcurrency: resolvedOptions.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        });
        return new MissionControlServices(omoRoot, resolvedOptions, sqlServices);
    }

    getJobManager(): AsyncJobManager {
        return this.sqlServices.jobManager;
    }

    getLifecycleManager(): AgentLifecycleManager {
        return this.sqlServices.lifecycleManager;
    }

    getRuntimeRegistry(): RuntimeAgentRegistry {
        return this.sqlServices.runtimeRegistry;
    }

    getTaskRuntimeServices(): TaskToolRuntimeServices {
        return this.sqlServices;
    }

    getOmoRoot(): string {
        return this.omoRoot;
    }

    getMaxConcurrency(): number {
        return this.maxConcurrency;
    }

    getDefaultIdleTtlMs(): number {
        return this.defaultIdleTtlMs;
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * Serializable view for the runtime panel: job stats (active, total,
     * per-status), visible-agent stats (per-status), the omo root, and the
     * configured limits. Computed from the public manager surfaces so the
     * panel never reaches into manager internals.
     */
    snapshot(): MissionControlServicesSnapshot {
        const jobs = this.sqlServices.jobManager.listJobs();
        const jobByStatus: Record<BackgroundJobHandle['status'], number> = {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        };
        for (const job of jobs) jobByStatus[job.status] += 1;

        const visible = this.sqlServices.runtimeRegistry.listVisibleTo(MAIN_AGENT_ID);
        const agentByStatus: Record<AgentStatus, number> = {
            running: 0,
            idle: 0,
            parked: 0,
            aborted: 0,
        };
        for (const ref of visible) agentByStatus[ref.status] += 1;

        return {
            omoRoot: this.omoRoot,
            maxConcurrency: this.maxConcurrency,
            defaultIdleTtlMs: this.defaultIdleTtlMs,
            disposed: this.disposed,
            jobs: {
                activeCount: this.sqlServices.jobManager.getActiveCount(),
                total: jobs.length,
                byStatus: jobByStatus,
            },
            agents: {
                visibleCount: visible.length,
                byStatus: agentByStatus,
            },
        };
    }

    /**
     * Cancel every non-terminal job, release every adopted agent, and clear the
     * registry. Idempotent. Managers remain accessible after dispose (they are
     * drained, not detached); a disposed instance reports `disposed: true` in
     * its snapshot and is replaced by the factory on next access.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const job of this.sqlServices.jobManager.listJobs()) {
            if (job.status === 'queued' || job.status === 'running') {
                this.sqlServices.jobManager.cancelJob(job.jobId);
            }
        }
        for (const ref of this.sqlServices.runtimeRegistry.listVisibleTo(MAIN_AGENT_ID)) {
            await this.sqlServices.lifecycleManager.release(ref.id);
        }
        this.sqlServices.runtimeRegistry.clear();
        await this.sqlServices.close();
    }
}

const instances = new Map<string, Promise<MissionControlServices>>();

/**
 * Lazily build and cache one {@link MissionControlServices} per absolute
 * workspace root. Concurrent calls with the same root share a single in-flight
 * construction; later calls reuse the resolved instance. A disposed instance is
 * rebuilt on the next call so a new session gets fresh managers.
 */
export async function getOrCreateMissionControlServices(
    workspaceRoot: string,
    options?: MissionControlServicesOptions,
): Promise<MissionControlServices> {
    const key = resolve(workspaceRoot);
    const cached = instances.get(key);
    if (cached !== undefined) {
        const instance = await cached;
        if (!instance.isDisposed()) return instance;
        if (instances.get(key) === cached) instances.delete(key);
    }
    const pending = MissionControlServices.create(workspaceRoot, options);
    instances.set(key, pending);
    pending.catch(() => {
        if (instances.get(key) === pending) instances.delete(key);
    });
    return pending;
}

export function isOmoRootNotFoundError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.name === 'OmoPersistenceError' &&
        'code' in error &&
        error.code === 'omo_root_not_found'
    );
}

/**
 * Dispose every cached {@link MissionControlServices} and clear the module
 * cache. Intended for process teardown: the CLI entrypoint calls this in its
 * top-level `finally` so manager state (jobs, adopted agents, registry) is
 * released when the process exits instead of leaking until GC.
 *
 * Each entry is cleared in its own `try/finally` so a rejecting construction
 * promise or a throwing `dispose()` still drops that entry from the cache.
 * Does NOT call {@link resetMissionControlServicesCache}; that test seam
 * clears without disposing and is superseded by this for production teardown.
 */
export async function disposeAllMissionControlServices(): Promise<void> {
    const entries = Array.from(instances.entries());
    for (const [key, pending] of entries) {
        try {
            const instance = await pending;
            await instance.dispose();
        } finally {
            if (instances.get(key) === pending) {
                instances.delete(key);
            }
        }
    }
}

/** Test seam: drop every cached instance so the next call rebuilds. */
export function resetMissionControlServicesCache(): void {
    instances.clear();
}
