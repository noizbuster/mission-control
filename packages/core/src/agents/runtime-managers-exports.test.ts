import {
    type AdoptOptions,
    type AgentDisposer,
    type AgentKind,
    AgentLifecycleManager,
    type AgentRef,
    type AgentRefInput,
    type AgentReviver,
    type AgentStatus,
    type AgentUpdatePatch,
    AsyncJobManager,
    type BackgroundJobHandle,
    getRuntimeRegistry,
    type JobExecuteFn,
    type LifecycleAdoptOptions,
    MAIN_AGENT_ID,
    type PersistedSubagentReviverFactory,
    RuntimeAgentRegistry,
    type StartJobInput,
} from '@mission-control/core';
import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * Import-contract test: the live-session registry, lifecycle manager, and
 * async job manager the CLI runtime panel consumes must be reachable as named
 * imports from the `@mission-control/core` package entry point. Internal
 * spawn/runaway policy symbols (RunawayGuard, RecursionTracker, canSpawn) are
 * intentionally out of scope and must NOT be exported by this change.
 */
describe('agent runtime-manager public exports', () => {
    const VALUES: ReadonlyArray<readonly [string, unknown]> = [
        ['AsyncJobManager', AsyncJobManager],
        ['AgentLifecycleManager', AgentLifecycleManager],
        ['RuntimeAgentRegistry', RuntimeAgentRegistry],
        ['getRuntimeRegistry', getRuntimeRegistry],
        ['MAIN_AGENT_ID', MAIN_AGENT_ID],
    ];

    it.each(VALUES)('%s is exported and defined', (_name, value) => {
        expect(value).toBeDefined();
    });

    it('exports the three manager classes as constructable functions', () => {
        expect(typeof AsyncJobManager).toBe('function');
        expect(typeof AgentLifecycleManager).toBe('function');
        expect(typeof RuntimeAgentRegistry).toBe('function');
    });

    it('exports getRuntimeRegistry as a function', () => {
        expect(typeof getRuntimeRegistry).toBe('function');
    });

    it('exports MAIN_AGENT_ID as the canonical main-session id', () => {
        expect(MAIN_AGENT_ID).toBe('Main');
    });

    it('getRuntimeRegistry returns a RuntimeAgentRegistry instance', () => {
        const registry = getRuntimeRegistry();
        expect(registry).toBeInstanceOf(RuntimeAgentRegistry);
    });

    it('constructs the managers against their documented wiring', () => {
        const registry = new RuntimeAgentRegistry();
        const lifecycle = new AgentLifecycleManager(registry);
        const jobs = new AsyncJobManager(2);
        expect(lifecycle).toBeInstanceOf(AgentLifecycleManager);
        expect(jobs).toBeInstanceOf(AsyncJobManager);
        expect(jobs.getActiveCount()).toBe(0);
    });

    it('re-exports the associated type surface (compile-time contract)', () => {
        // These assertions pin the named type re-exports so a dropped `export
        // type` line fails the build, not just a downstream consumer.
        expectTypeOf<AgentStatus>().toEqualTypeOf<'running' | 'idle' | 'parked' | 'aborted'>();
        expectTypeOf<AgentKind>().toEqualTypeOf<'main' | 'sub' | 'advisor'>();
        expectTypeOf<typeof MAIN_AGENT_ID>().toMatchTypeOf<string>();

        // Structural smoke checks: the types resolve to non-never shapes.
        expectTypeOf<AgentRef>().toMatchTypeOf<{ readonly id: string; status: AgentStatus }>();
        expectTypeOf<AgentRefInput>().toMatchTypeOf<{ readonly id: string; status: AgentStatus }>();
        expectTypeOf<AgentUpdatePatch>().toMatchTypeOf<Partial<AgentRef>>();
        expectTypeOf<AdoptOptions>().toMatchTypeOf<{ readonly idleTtlMs?: number }>();

        expectTypeOf<BackgroundJobHandle>().toMatchTypeOf<{
            readonly jobId: string;
            status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
        }>();
        expectTypeOf<JobExecuteFn>().toMatchTypeOf<
            (signal: AbortSignal) => Promise<{ status: 'completed' | 'failed'; output: string }>
        >();
        expectTypeOf<StartJobInput>().toMatchTypeOf<{ readonly sessionId: string; readonly execute: JobExecuteFn }>();

        expectTypeOf<LifecycleAdoptOptions>().toMatchTypeOf<{ readonly idleTtlMs?: number }>();
        expectTypeOf<AgentReviver>().toMatchTypeOf<(id: string) => Promise<AgentRef>>();
        expectTypeOf<AgentDisposer>().toMatchTypeOf<(id: string) => Promise<void>>();
        expectTypeOf<PersistedSubagentReviverFactory>().toMatchTypeOf<
            (ref: AgentRef) => Promise<AgentReviver | undefined>
        >();
    });
});
