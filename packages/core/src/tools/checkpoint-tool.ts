// allow: SIZE_OK — two small tool factories plus a tiny session-scoped coordinator.
/**
 * `checkpoint` + `rewind` tools — session-scoped conversation-state collapse.
 *
 * Ported from oh-my-pi's `CheckpointTool` / `RewindTool` (MIT, Can Boluk /
 * Mario Zechner), rewritten to mission-control's `ToolRegistration` factory
 * pattern. `checkpoint` marks the current conversation state in an in-memory,
 * session-scoped {@link CheckpointCoordinator}; `rewind` collapses the
 * exploratory context between the checkpoint and itself into a concise report.
 *
 * Neither tool writes a persistent store: state lives in the coordinator, which
 * is constructed once per session and dies with it. The boulder persistence
 * seam (`readBoulder`/`writeBoulder` direct, NOT `updateBoulderWork`) is the
 * documented safe path for any future cross-session survival — `updateBoulderWork`'s
 * patch type excludes custom passthrough fields, so routing checkpoint state
 * through it would silently drop the report. That seam is locked by a contract
 * test in `checkpoint-tool.test.ts`, not wired into the in-memory coordinator.
 *
 * Division of labor mirrors oh-my-pi: the tools mark/validate/collapse; the
 * actual in-memory message-buffer pruning is the session layer's job, guided by
 * the coordinator's captured `collapsedMessageCount`.
 */
import { z } from 'zod';
import { ToolExecutionError, type ToolRegistration } from './tool-registry-types';

export const CHECKPOINT_TOOL_NAME = 'checkpoint';
export const REWIND_TOOL_NAME = 'rewind';

/** Session-scoped checkpoint marker. In-memory only; never persisted by the coordinator. */
export interface CheckpointState {
    readonly goal: string;
    readonly startedAt: string;
    /** In-memory message count captured at the checkpoint (AFTER the checkpoint result lands). */
    readonly messageCount: number;
    /** Session tree entry id at the checkpoint, when known. */
    readonly entryId: string | null;
}

/** Captured rewind report plus the collapse window it replaced. */
export interface RewindRecord {
    readonly report: string;
    readonly rewoundAt: string;
    readonly collapsedMessageCount: number;
    readonly checkpointStartedAt: string;
    readonly goal: string;
}

export type CheckpointCoordinatorErrorCode = 'checkpoint_active' | 'checkpoint_missing';

export class CheckpointCoordinatorError extends Error {
    readonly code: CheckpointCoordinatorErrorCode;
    constructor(message: string, code: CheckpointCoordinatorErrorCode) {
        super(message);
        this.name = 'CheckpointCoordinatorError';
        this.code = code;
    }
}

/**
 * Per-session, in-memory holder for the active checkpoint and the most recent
 * rewind. Construct one per session and inject it into both tool registrations
 * so `checkpoint` and `rewind` share state. Holds NO durable handle: the state
 * is session-scoped and does not survive the session unless a host explicitly
 * ferries a report through the boulder passthrough seam.
 */
export class CheckpointCoordinator {
    private checkpoint: CheckpointState | null = null;
    private rewind: RewindRecord | null = null;

    /** Set the active checkpoint. Throws if one is already active. */
    markCheckpoint(state: CheckpointState): void {
        if (this.checkpoint !== null) {
            throw new CheckpointCoordinatorError('Checkpoint already active.', 'checkpoint_active');
        }
        this.checkpoint = state;
    }

    getCheckpoint(): CheckpointState | null {
        return this.checkpoint;
    }

    /**
     * Collapse the active checkpoint into a rewind record and clear the marker.
     * Throws when no checkpoint is active. Returns the captured record so the
     * caller (rewind tool / session layer) can prune the in-memory buffer over
     * the `collapsedMessageCount` window.
     */
    recordRewind(report: string, rewoundAt: string): RewindRecord {
        const active = this.checkpoint;
        if (active === null) {
            throw new CheckpointCoordinatorError('No active checkpoint.', 'checkpoint_missing');
        }
        const record: RewindRecord = {
            report,
            rewoundAt,
            collapsedMessageCount: active.messageCount,
            checkpointStartedAt: active.startedAt,
            goal: active.goal,
        };
        this.rewind = record;
        this.checkpoint = null;
        return record;
    }

    getRewind(): RewindRecord | null {
        return this.rewind;
    }

    clear(): void {
        this.checkpoint = null;
        this.rewind = null;
    }
}

// ============================ checkpoint tool ============================

const checkpointInputSchema = z
    .object({
        goal: z.string().min(1).max(4_000),
    })
    .strict();

export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

export type CheckpointOutput = {
    readonly goal: string;
    readonly startedAt: string;
    readonly messageCount: number;
    readonly entryId: string | null;
};

const checkpointOutputSchema = z
    .object({
        goal: z.string().min(1),
        startedAt: z.string().min(1),
        messageCount: z.number().int().nonnegative(),
        entryId: z.string().min(1).nullable(),
    })
    .strict();

/**
 * Snapshot the coordinator reads at mark time. A real session wires live
 * accessors; tests and bare hosts default to an empty buffer so the tool stays
 * usable without a session.
 */
export interface CheckpointToolDependencies {
    readonly coordinator: CheckpointCoordinator;
    /** Returns the in-memory message count + entry id to capture. Defaults to empty. */
    readonly resolveSnapshot?: () => { readonly messageCount: number; readonly entryId: string | null };
    /** Injectable clock so tests are deterministic. Defaults to `new Date().toISOString()`. */
    readonly now?: () => string;
}

export function createCheckpointToolRegistration(
    deps: CheckpointToolDependencies,
): ToolRegistration<CheckpointInput, CheckpointOutput> {
    return {
        name: CHECKPOINT_TOOL_NAME,
        description:
            'Mark the current conversation state so a later `rewind` can collapse the exploratory context ' +
            'between the checkpoint and itself into a concise report. Only one checkpoint may be active at a ' +
            'time. Session-scoped: the marker lives in memory for this session only.',
        capabilityClasses: ['read'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                goal: {
                    type: 'string',
                    description: 'The investigation goal this checkpoint anchors.',
                },
            },
            required: ['goal'],
            additionalProperties: false,
        },
        inputSchema: checkpointInputSchema,
        outputSchema: checkpointOutputSchema,
        outputLimit: { maxModelOutputChars: 2000 },
        execute: async (input) => {
            if (deps.coordinator.getCheckpoint() !== null) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: 'A checkpoint is already active. Call rewind with a report before checkpointing again.',
                    retryable: true,
                });
            }
            const now = deps.now?.() ?? new Date().toISOString();
            const snapshot = deps.resolveSnapshot?.() ?? { messageCount: 0, entryId: null };
            const state: CheckpointState = {
                goal: input.goal,
                startedAt: now,
                messageCount: snapshot.messageCount,
                entryId: snapshot.entryId,
            };
            deps.coordinator.markCheckpoint(state);
            return {
                goal: state.goal,
                startedAt: state.startedAt,
                messageCount: state.messageCount,
                entryId: state.entryId,
            };
        },
        toModelOutput: (output) =>
            [
                'Checkpoint created.',
                `Goal: ${output.goal}`,
                `Messages at mark: ${output.messageCount}.`,
                'Run your investigation, then call rewind with a concise report.',
            ].join('\n'),
        guideline:
            'Call checkpoint before an exploratory investigation you may want to collapse. Record the goal; ' +
            'follow it with exactly one rewind carrying a concise findings report. checkpoint is session-scoped ' +
            'and never persists state.',
    };
}

// ============================ rewind tool ============================

const rewindInputSchema = z
    .object({
        report: z.string().min(1).max(20_000),
    })
    .strict();

export type RewindInput = z.infer<typeof rewindInputSchema>;

export type RewindOutput = {
    readonly report: string;
    readonly rewound: boolean;
    readonly rewoundAt: string;
    readonly collapsedMessageCount: number;
};

const rewindOutputSchema = z
    .object({
        report: z.string().min(1),
        rewound: z.boolean(),
        rewoundAt: z.string().min(1),
        collapsedMessageCount: z.number().int().nonnegative(),
    })
    .strict();

export interface RewindToolDependencies {
    readonly coordinator: CheckpointCoordinator;
    /** Injectable clock so tests are deterministic. Defaults to `new Date().toISOString()`. */
    readonly now?: () => string;
}

export function createRewindToolRegistration(
    deps: RewindToolDependencies,
): ToolRegistration<RewindInput, RewindOutput> {
    return {
        name: REWIND_TOOL_NAME,
        description:
            'Collapse the exploratory context since the last `checkpoint` into a concise report. Requires an ' +
            'active checkpoint; the checkpoint is consumed and the report replaces the intervening context. ' +
            'Session-scoped: no persistent store is written.',
        capabilityClasses: ['coordination'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                report: {
                    type: 'string',
                    description: 'Concise findings report that replaces the exploratory context since the checkpoint.',
                },
            },
            required: ['report'],
            additionalProperties: false,
        },
        inputSchema: rewindInputSchema,
        outputSchema: rewindOutputSchema,
        outputLimit: { maxModelOutputChars: 4000 },
        execute: async (input) => {
            if (deps.coordinator.getCheckpoint() === null) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: 'No active checkpoint to rewind. Call checkpoint with a goal first.',
                    retryable: true,
                });
            }
            const now = deps.now?.() ?? new Date().toISOString();
            const record = deps.coordinator.recordRewind(input.report, now);
            return {
                report: record.report,
                rewound: true,
                rewoundAt: record.rewoundAt,
                collapsedMessageCount: record.collapsedMessageCount,
            };
        },
        toModelOutput: (output) =>
            [
                `Rewind applied. Collapsed ${output.collapsedMessageCount} message(s) since the checkpoint.`,
                'Report captured for context replacement:',
                output.report,
            ].join('\n'),
        guideline:
            'Call rewind exactly once after a checkpoint, carrying a concise findings report. The exploratory ' +
            'context between the checkpoint and this rewind is collapsed into the report. rewind without an ' +
            'active checkpoint is an error.',
    };
}
