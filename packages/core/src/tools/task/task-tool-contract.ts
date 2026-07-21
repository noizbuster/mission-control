import type { PolicyEffectRule } from '@mission-control/protocol';
import { z } from 'zod';
import type { SessionControlEpoch } from '../../runtime/session-control-cancellation';
import type { CategoryDefinition } from './category-catalog';

export const batchTaskItemSchema = z
    .object({
        agent: z.string().min(1),
        assignment: z.string().min(1),
        role: z.string().optional(),
        title: z.string().min(1).max(200).optional(),
    })
    .strict();

export const taskToolBaseObjectSchema = z
    .object({
        category: z.string().min(1).optional(),
        subagent_type: z.string().min(1).optional(),
        agent: z.string().min(1).optional(),
        load_skills: z.array(z.string().min(1)).default([]),
        prompt: z.string().min(1).optional(),
        assignment: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
        task_id: z.string().min(1).optional(),
        tasks: z.array(batchTaskItemSchema).optional(),
        context: z.string().optional(),
        title: z.string().min(1).max(200).optional(),
    })
    .strict();

export const taskToolInputSchema = taskToolBaseObjectSchema
    .refine((data) => !(data.category !== undefined && data.subagent_type !== undefined), {
        message: "Provide either 'category' or 'subagent_type', not both",
    })
    .refine(
        (data) => [data.category, data.subagent_type, data.agent].filter((value) => value !== undefined).length <= 1,
        {
            message: "Provide at most one of 'category', 'subagent_type', or 'agent'",
        },
    )
    .refine((data) => !(data.prompt !== undefined && data.assignment !== undefined), {
        message: "Provide either 'prompt' or 'assignment', not both",
    })
    .refine(
        (data) => {
            const hasBatch = data.tasks !== undefined;
            const hasSingle = data.prompt !== undefined || data.assignment !== undefined;
            return hasBatch !== hasSingle;
        },
        { message: "Provide either 'tasks' (batch) or 'prompt'/'assignment' (single), not both" },
    )
    .refine((data) => data.tasks === undefined || data.tasks.length > 0, {
        message: "'tasks' must contain at least one entry",
    });

const batchResultItemSchema = z
    .object({
        role: z.string().optional(),
        sessionId: z.string().min(1),
        status: z.enum(['completed', 'failed']),
        output: z.string(),
    })
    .strict();

export const taskToolOutputSchema = z
    .object({
        sessionId: z.string().min(1),
        backgroundId: z.string().min(1).optional(),
        status: z.enum(['running', 'completed', 'failed']),
        output: z.string().optional(),
        batch: z.array(batchResultItemSchema).optional(),
    })
    .strict();

export type TaskToolParams = z.infer<typeof taskToolInputSchema>;
export type TaskToolResult = z.infer<typeof taskToolOutputSchema>;
export type BatchTaskItem = z.infer<typeof batchTaskItemSchema>;
export type BatchResultItem = z.infer<typeof batchResultItemSchema>;

export interface ChildSpawnRequest {
    readonly sessionId: string;
    readonly prompt: string;
    readonly category?: CategoryDefinition;
    readonly subagentType?: string;
    readonly loadSkills: readonly string[];
    readonly childPermissions: readonly PolicyEffectRule[];
    /**
     * Depth assigned to the session being spawned (child depth). Root children
     * of MAIN default to `0` only when unset before runtime stamping; the
     * runtime always stamps `parentDepth + 1` before authority prep.
     */
    readonly taskDepth?: number;
    readonly parentContext?: string;
    /** Optional short title for child ask_user overlay source labeling. */
    readonly title?: string;
    readonly signal?: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
}

export const CHILD_SPAWN_FAILURE_KINDS = [
    'yield_missing',
    'graph_failed',
    'tool_denied',
    'aborted',
] as const;
export type ChildSpawnFailureKind = (typeof CHILD_SPAWN_FAILURE_KINDS)[number];

export interface ChildSpawnResult {
    readonly sessionId: string;
    readonly status: 'completed' | 'failed';
    readonly output: string;
    readonly failureKind?: ChildSpawnFailureKind;
}

export interface TaskToolBackgroundHandle {
    readonly sessionId: string;
    readonly backgroundId: string;
}

export interface TaskToolRuntime {
    readonly runChildSession: (request: ChildSpawnRequest) => Promise<ChildSpawnResult>;
    readonly startBackgroundSession: (request: ChildSpawnRequest) => TaskToolBackgroundHandle;
    readonly resumeChildSession: (sessionId: string, request: ChildSpawnRequest) => Promise<ChildSpawnResult>;
    readonly sessionExists: (sessionId: string) => boolean;
    readonly generateSessionId: () => string;
}

export interface CreateFullParityTaskToolOptions {
    readonly runtime: TaskToolRuntime;
}
