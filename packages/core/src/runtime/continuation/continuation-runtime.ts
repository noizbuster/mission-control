/**
 * Session-spanning continuation runtime. Wraps multiple `runGraph` invocations,
 * persisting continuation state between sessions in the boulder work entry.
 *
 * This is DISTINCT from the graph-level `maxNodeRuns` (which bounds a single
 * execution): this runtime bounds how many TIMES a graph that emits
 * `loop_active=true` can resume across session boundaries. The graph signals
 * `loop_active=true` to request another session; a DONE signal or
 * `maxIterations` terminates the continuation chain.
 *
 * DONE signal detection is delegated to the caller via `runGraphFn` — the
 * adapter inspects the real graph result (explicit DONE string, termination
 * event, or `loop_active: false`) and reports `{ done: true }`. This keeps the
 * continuation runtime decoupled from the exact signal mechanism.
 *
 * State persistence: continuation state is stored as a `continuation_runtime`
 * passthrough field on the boulder work entry (the schema uses `.passthrough()`
 * so custom fields survive validation round-trips).
 */

import { z } from 'zod';
import { type BoulderWork, type RunnerStopMarker, readBoulder } from '../../persistence/boulder-store.js';
import { mutateBoulderWork } from '../../persistence/boulder-work-mutation.js';
import { randomUUID } from 'node:crypto';

const CONTINUATION_STATE_KEY = 'continuation_runtime';

export interface ContinuationOptions {
    readonly maxIterations: number;
    readonly boulderRoot: string;
    readonly workId: string;
}

export interface ContinuationState {
    readonly iteration: number;
    readonly loopActive: boolean;
    readonly doneSignal: boolean;
    readonly lastSessionId: string | undefined;
    readonly startedAt: string;
    readonly stoppedAt?: string | undefined;
    readonly stoppedReason?: string | undefined;
}

export interface GraphRunContinuationResult {
    readonly loopActive: boolean;
    readonly done: boolean;
    readonly output: unknown;
}

export type RunGraphFn = (sessionId: string) => Promise<GraphRunContinuationResult>;

export type ContinuationOutcome =
    | { readonly status: 'continue'; readonly sessionId: string; readonly iteration: number }
    | {
          readonly status: 'done';
          readonly iterations: number;
          readonly reason: 'done_signal' | 'max_iterations' | 'loop_inactive' | 'stopped';
      };

const PersistedContinuationStateSchema = z.object({
    iteration: z.number().int().nonnegative(),
    loopActive: z.boolean(),
    doneSignal: z.boolean(),
    lastSessionId: z.string().optional(),
    startedAt: z.string(),
});

export class ContinuationRuntimeError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
        this.name = 'ContinuationRuntimeError';
    }
}

export class ContinuationRuntime {
    constructor(private readonly options: ContinuationOptions) {}

    shouldContinue(state: ContinuationState): boolean {
        if (state.stoppedAt !== undefined) return false;
        return state.loopActive && !state.doneSignal && state.iteration < this.options.maxIterations;
    }

    isStopped(state: ContinuationState): boolean {
        return state.stoppedAt !== undefined;
    }

    advance(state: ContinuationState, sessionId: string): ContinuationState {
        return { ...state, iteration: state.iteration + 1, lastSessionId: sessionId };
    }

    signalDone(state: ContinuationState): ContinuationState {
        return { ...state, doneSignal: true };
    }

    initialState(now: string = new Date().toISOString()): ContinuationState {
        return {
            iteration: 0,
            loopActive: false,
            doneSignal: false,
            lastSessionId: undefined,
            startedAt: now,
            stoppedAt: undefined,
            stoppedReason: undefined,
        };
    }

    async persistState(state: ContinuationState): Promise<void> {
        const validated = PersistedContinuationStateSchema.parse(state);
        await this.mutateWork((work) => ({ ...work, [CONTINUATION_STATE_KEY]: validated }));
    }

    async loadState(): Promise<ContinuationState | null> {
        const boulder = await readBoulder(this.options.boulderRoot);
        if (boulder === null) return null;
        const work = boulder.works[this.options.workId];
        if (work === undefined) return null;
        const raw = readWorkExtension(work);
        if (raw === undefined) {
            if (work.runner_stop === undefined) return null;
            return {
                ...this.initialState(work.started_at),
                stoppedAt: work.runner_stop.stopped_at,
                stoppedReason: work.runner_stop.stopped_reason,
            };
        }
        const parsed = PersistedContinuationStateSchema.safeParse(raw);
        if (!parsed.success) {
            if (work.runner_stop === undefined) return null;
            return {
                ...this.initialState(work.started_at),
                stoppedAt: work.runner_stop.stopped_at,
                stoppedReason: work.runner_stop.stopped_reason,
            };
        }
        return {
            iteration: parsed.data.iteration,
            loopActive: parsed.data.loopActive,
            doneSignal: parsed.data.doneSignal,
            lastSessionId: parsed.data.lastSessionId,
            startedAt: parsed.data.startedAt,
            stoppedAt: work.runner_stop?.stopped_at,
            stoppedReason: work.runner_stop?.stopped_reason,
        };
    }

    async markStopped(reason: string, now: string = new Date().toISOString()): Promise<void> {
        const stopMarker: RunnerStopMarker = {
            stopped_at: now,
            stopped_reason: reason,
        };
        await this.mutateWork((work) => ({ ...work, runner_stop: stopMarker }));
    }

    async clearStopped(): Promise<void> {
        const boulder = await readBoulder(this.options.boulderRoot);
        if (boulder === null) return;
        const work = boulder.works[this.options.workId];
        if (work === undefined) return;
        if (work.runner_stop === undefined) return;
        await this.mutateWork((latestWork) => {
            const workWithoutStop = { ...latestWork };
            delete workWithoutStop.runner_stop;
            return workWithoutStop;
        });
    }

    private async mutateWork(mutation: (work: BoulderWork) => BoulderWork): Promise<void> {
        try {
            await mutateBoulderWork(this.options.boulderRoot, this.options.workId, mutation);
        } catch (error: unknown) {
            if (error instanceof Error && 'code' in error) {
                const code = error.code;
                if (code === 'boulder_missing' || code === 'boulder_work_missing') {
                    if (code === 'boulder_missing') {
                        throw new ContinuationRuntimeError(
                            `Cannot operate on work: boulder.json missing at ${this.options.boulderRoot}`,
                            code,
                        );
                    }
                    throw new ContinuationRuntimeError(
                        `Cannot operate on work: work ${this.options.workId} not found`,
                        'work_missing',
                    );
                }
            }
            throw error;
        }
    }

    async runWithContinuation(sessionId: string, runGraphFn: RunGraphFn): Promise<ContinuationOutcome> {
        const loaded = await this.loadState();
        const prior = loaded ?? this.initialState();

        if (prior.stoppedAt !== undefined) {
            return { status: 'done', iterations: prior.iteration, reason: 'stopped' };
        }

        const result = await runGraphFn(sessionId);

        const latest = await this.loadState();

        const observed: ContinuationState = {
            ...prior,
            loopActive: result.loopActive,
            doneSignal: result.done,
            lastSessionId: sessionId,
            stoppedAt: latest?.stoppedAt,
            stoppedReason: latest?.stoppedReason,
        };

        if (observed.doneSignal) {
            await this.persistState(observed);
            return { status: 'done', iterations: observed.iteration, reason: 'done_signal' };
        }

        if (observed.stoppedAt !== undefined) {
            await this.persistState(observed);
            return { status: 'done', iterations: observed.iteration, reason: 'stopped' };
        }

        if (this.shouldContinue(observed)) {
            const nextSessionId = randomUUID();
            const advanced = this.advance(observed, nextSessionId);
            await this.persistState(advanced);
            return { status: 'continue', sessionId: nextSessionId, iteration: advanced.iteration };
        }

        await this.persistState(observed);
        const reason = observed.iteration >= this.options.maxIterations ? 'max_iterations' : 'loop_inactive';
        return { status: 'done', iterations: observed.iteration, reason };
    }
}

function readWorkExtension(work: BoulderWork): unknown {
    return (work as BoulderWork & { readonly continuation_runtime?: unknown }).continuation_runtime;
}
