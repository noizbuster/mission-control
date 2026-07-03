/**
 * `job` tool — background task control (wait / cancel / list by id).
 *
 * Companion to the full-parity `task()` tool's background mode. The model launches a
 * background child via `task({..., run_in_background: true})` and receives a
 * `backgroundId`; this tool lets it WAIT for the result, CANCEL a running job, or LIST
 * active jobs — all by id. It deliberately has NO "cancel all" / `all=true` mode: mass
 * cancellation is an anti-pattern (AGENTS.md) and is rejected by the strict schema
 * (unknown keys fail validation, and a dedicated test pins the rejection).
 *
 * Capability class `'subagent'` groups it with the task tool, and
 * {@linkcode ConcreteTaskToolRuntime.buildChildToolSurface} drops it by name alongside
 * `task` — children never get control over the parent's job manager.
 *
 * The tool holds an injected {@linkcode AsyncJobManager} handle (the same instance the
 * runtime services share) and performs NO provider calls, so tests inject a real manager
 * with a controllable execute function.
 *
 * Adapted from opencode's background-job notify pattern (opencode MIT, Copyright (c) 2025
 * opencode), rewritten to plain TS: opencode auto-injects a synthetic message on
 * completion via an effect-runtime service; here the model explicitly waits/cancels via
 * this tool, keeping the surface dependency-free.
 */
import { z } from 'zod';
import type { AsyncJobManager, BackgroundJobHandle } from '../agents/async-job-manager.js';
import { ToolExecutionError, type ToolRegistration } from './tool-registry-types.js';

export const JOB_TOOL_NAME = 'job';

const JOB_OUTPUT_LIMIT = { maxModelOutputChars: 4000 } as const;

export const jobInputSchema = z
    .object({
        action: z.enum(['wait', 'cancel', 'list']),
        job_id: z.string().min(1).optional(),
    })
    .strict()
    .refine((data) => data.action === 'list' || data.job_id !== undefined, {
        message: "'job_id' is required for 'wait' and 'cancel' actions",
        path: ['job_id'],
    });

export type JobToolParams = z.infer<typeof jobInputSchema>;

const jobSummaryEntrySchema = z
    .object({
        job_id: z.string().min(1),
        session_id: z.string().min(1),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    })
    .strict();

const jobOutputSchema = z
    .object({
        action: z.enum(['wait', 'cancel', 'list']),
        job_id: z.string().min(1).optional(),
        status: z.enum(['completed', 'failed', 'cancelled', 'running', 'queued', 'not_found']),
        output: z.string().optional(),
        error: z.string().optional(),
        jobs: z.array(jobSummaryEntrySchema).optional(),
    })
    .strict();

export type JobToolResult = z.infer<typeof jobOutputSchema>;

export interface JobToolDependencies {
    /** Shared job manager instance (same one backing the task tool's background mode). */
    readonly jobManager: AsyncJobManager;
}

/**
 * Build the `job` tool registration. `deps.jobManager` is the live manager shared with
 * the runtime services; tests inject a real `AsyncJobManager` with a controllable execute
 * function so wait/cancel can be driven deterministically.
 */
export function createJobToolRegistration(deps: JobToolDependencies): ToolRegistration<JobToolParams, JobToolResult> {
    return {
        name: JOB_TOOL_NAME,
        description:
            'Control a background task launched by the task tool. WAIT blocks until the job ' +
            'finishes and returns its result; CANCEL stops a running or queued job by id; LIST ' +
            'shows every job and its status. Operates one job at a time by id — there is no ' +
            '"cancel all" mode.',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['wait', 'cancel', 'list'],
                    description: 'wait = block until the job finishes; cancel = stop a job; list = show all jobs.',
                },
                job_id: {
                    type: 'string',
                    description:
                        'The background id returned by task({run_in_background:true}). Required for wait and cancel.',
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        inputSchema: jobInputSchema,
        outputSchema: jobOutputSchema,
        outputLimit: JOB_OUTPUT_LIMIT,
        execute: async (input) => {
            if (input.action === 'list') {
                return listResult(deps.jobManager.listJobs());
            }
            // The schema refine guarantees job_id for wait/cancel; the guard keeps the
            // narrowing sound under exactOptionalPropertyTypes.
            const jobId = input.job_id;
            if (jobId === undefined) {
                throw new ToolExecutionError({
                    code: 'schema_invalid',
                    message: "'job_id' is required for 'wait' and 'cancel' actions",
                    retryable: false,
                });
            }
            if (input.action === 'cancel') {
                return cancelResult(deps.jobManager, jobId);
            }
            return waitResult(deps.jobManager, jobId);
        },
        toModelOutput: (output) => formatJobModelOutput(output),
        guideline:
            'Use after task({run_in_background:true}). WAIT returns the finished result; CANCEL ' +
            'stops one job by id. Never pass `all` — operate one job at a time. Use LIST to ' +
            'discover job ids.',
    };
}

async function waitResult(jobManager: AsyncJobManager, jobId: string): Promise<JobToolResult> {
    let handle: BackgroundJobHandle;
    try {
        handle = await jobManager.awaitJob(jobId);
    } catch {
        // awaitJob throws for an unknown id; surface a clean not_found to the model.
        return { action: 'wait', job_id: jobId, status: 'not_found' };
    }
    return handleToWaitResult(handle);
}

function handleToWaitResult(handle: BackgroundJobHandle): JobToolResult {
    const base = { action: 'wait' as const, job_id: handle.jobId };
    if (handle.status === 'cancelled') {
        return { ...base, status: 'cancelled' };
    }
    if (handle.status === 'failed') {
        return {
            ...base,
            status: 'failed',
            ...(handle.result?.output !== undefined ? { output: handle.result.output } : {}),
            ...(handle.error !== undefined ? { error: handle.error } : {}),
        };
    }
    if (handle.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            ...(handle.result?.output !== undefined ? { output: handle.result.output } : {}),
        };
    }
    // queued / running — awaitJob resolved before terminal (cooperative early return).
    return { ...base, status: handle.status };
}

function cancelResult(jobManager: AsyncJobManager, jobId: string): JobToolResult {
    const before = jobManager.listJobs().find((h) => h.jobId === jobId);
    jobManager.cancelJob(jobId);
    const after = jobManager.listJobs().find((h) => h.jobId === jobId);
    if (before === undefined || after === undefined) {
        return { action: 'cancel', job_id: jobId, status: 'not_found' };
    }
    // cancelJob is a no-op on terminal jobs; report the resulting state honestly.
    if (after.status === 'cancelled') {
        return { action: 'cancel', job_id: jobId, status: 'cancelled' };
    }
    return { action: 'cancel', job_id: jobId, status: after.status };
}

function listResult(handles: readonly BackgroundJobHandle[]): JobToolResult {
    return {
        action: 'list',
        status: 'completed',
        jobs: handles.map((h) => ({
            job_id: h.jobId,
            session_id: h.sessionId,
            status: h.status,
        })),
    };
}

function formatJobModelOutput(output: JobToolResult): string {
    if (output.action === 'list') {
        const jobs = output.jobs ?? [];
        if (jobs.length === 0) return 'No background jobs.';
        const lines = jobs.map((j) => `- ${j.job_id} [${j.status}] (session ${j.session_id})`);
        return `Background jobs (${jobs.length}):\n${lines.join('\n')}`;
    }
    const label = output.job_id ?? '(unknown)';
    if (output.action === 'cancel') {
        if (output.status === 'not_found') return `Job ${label} not found.`;
        if (output.status === 'cancelled') return `Job ${label} cancelled.`;
        return `Job ${label} is ${output.status} (cancel was a no-op).`;
    }
    // wait
    if (output.status === 'not_found') return `Job ${label} not found.`;
    if (output.status === 'failed') {
        return `Job ${label} failed${output.error !== undefined ? `: ${output.error}` : ''}.`;
    }
    if (output.status === 'cancelled') return `Job ${label} was cancelled.`;
    if (output.status === 'completed') {
        const tail = output.output !== undefined ? truncate(output.output, 2000) : '';
        return `Job ${label} completed.${tail.length > 0 ? `\n${tail}` : ''}`;
    }
    return `Job ${label} is ${output.status}.`;
}

function truncate(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
