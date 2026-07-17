// allow: SIZE_OK — single cohesive concept (apply/discard a staged preview).
/**
 * `resolve` tool (Wave 4, task 12).
 *
 * A hidden coordination tool that applies or discards a queued preview action
 * (e.g. an `ast_edit` proposal). It peeks the session-scoped
 * {@link StagedPreviewRegistry}, dispatches the staged action's `apply` or
 * `discard` closure, and consumes the slot. Algorithm adapted from oh-my-pi's
 * `ResolveTool` (MIT, Can Bölük / Mario Zechner): `discard` with nothing
 * pending is a success (the desired no-op end-state already holds); `apply`
 * with nothing pending is a clear error.
 *
 * "Hidden" semantics: `resolve` is always available alongside a tool that
 * stages previews. Its capability class is `'edit'`. There is no separate
 * advertisement-suppression flag on `ToolRegistration` — the always-available
 * behaviour is a wiring concern at the registry-assembly site, mirroring how
 * `yield` stays available to child agents.
 */
import { z } from 'zod';
import type { StagedPreviewChange, StagedPreviewRegistry } from '../staged-preview-registry';
import { ToolExecutionError, type ToolRegistration } from '../tool-registry-types';

export const RESOLVE_TOOL_NAME = 'resolve';

export type ResolveInput = {
    readonly action: 'apply' | 'discard';
    readonly reason: string;
};

export type ResolveOutput = {
    readonly status: 'applied' | 'discarded' | 'nothing_pending';
    readonly action: 'apply' | 'discard';
    readonly reason: string;
    readonly sourceToolName?: string;
    readonly label?: string;
    /** Applied per-file summary (apply only). */
    readonly applied?: readonly StagedPreviewChange[];
    /** Proposed count carried from the staged preview (apply only). */
    readonly proposedCount?: number;
    readonly message: string;
};

export const resolveInputSchema = z
    .object({
        action: z.enum(['apply', 'discard']),
        reason: z.string().min(1),
    })
    .strict();

const stagedChangeSchema = z
    .object({
        path: z.string().min(1),
        count: z.number().int().nonnegative(),
    })
    .strict();

export const resolveOutputSchema = z
    .object({
        status: z.enum(['applied', 'discarded', 'nothing_pending']),
        action: z.enum(['apply', 'discard']),
        reason: z.string().min(1),
        sourceToolName: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        applied: z.array(stagedChangeSchema).optional(),
        proposedCount: z.number().int().nonnegative().optional(),
        message: z.string().min(1),
    })
    .strict();

export type ResolveToolOptions = {
    /** Shared with the proposing tool (e.g. `ast_edit`): where previews live. */
    readonly registry: StagedPreviewRegistry;
};

export function createResolveToolRegistration(
    options: ResolveToolOptions,
): ToolRegistration<ResolveInput, ResolveOutput> {
    return {
        name: RESOLVE_TOOL_NAME,
        description:
            'Apply or discard a queued preview action (e.g. an ast_edit proposal). ' +
            'Use action "apply" to commit the staged change to disk, or "discard" to drop it without writing.',
        capabilityClasses: ['edit'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['apply', 'discard'],
                    description: '"apply" commits the staged preview; "discard" drops it without writing.',
                },
                reason: {
                    type: 'string',
                    description: 'Short rationale for applying or discarding the staged preview.',
                },
            },
            required: ['action', 'reason'],
            additionalProperties: false,
        },
        inputSchema: resolveInputSchema as z.ZodType<ResolveInput>,
        outputSchema: resolveOutputSchema as z.ZodType<ResolveOutput>,
        outputLimit: { maxModelOutputChars: 4000 },
        execute: (input, context) => executeResolve(options.registry, input, context.toolCallId),
        toModelOutput: resolveModelOutput,
        guideline:
            'Call resolve after a tool returns a (proposed) preview to commit (apply) or drop (discard) the ' +
            'staged change. resolve is the ONLY commit path for previewed edits.',
    };
}

async function executeResolve(
    registry: StagedPreviewRegistry,
    input: ResolveInput,
    resolveToolCallId: string,
): Promise<ResolveOutput> {
    // Consume first: a failed apply clears the slot so the model re-proposes
    // rather than getting stuck on a preview that no longer matches disk.
    const action = registry.consume();
    if (action === undefined) {
        if (input.action === 'discard') {
            // discard with nothing pending is a success: the desired no-op
            // end-state (no staged change) already holds.
            return {
                status: 'nothing_pending',
                action: input.action,
                reason: input.reason,
                message: 'Nothing to discard; no pending preview remains.',
            };
        }
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'No pending preview to resolve. Call a preview tool (e.g. ast_edit) before resolve.',
            retryable: true,
        });
    }

    const summary = action.summary;
    if (input.action === 'discard') {
        await action.discard?.(input.reason);
        return {
            status: 'discarded',
            action: input.action,
            reason: input.reason,
            sourceToolName: summary.sourceToolName,
            label: summary.label,
            proposedCount: summary.proposedCount,
            message: `Discarded: ${summary.label}. Reason: ${input.reason}`,
        };
    }

    // action === 'apply'. The apply closure re-validates against current disk
    // and throws on staleness or write failure; that error propagates as a
    // failed tool settlement (the slot is already consumed).
    const applied = await action.apply(input.reason, resolveToolCallId);
    return {
        status: 'applied',
        action: input.action,
        reason: input.reason,
        sourceToolName: summary.sourceToolName,
        label: summary.label,
        applied,
        proposedCount: summary.proposedCount,
        message: `Applied: ${summary.label}. Reason: ${input.reason}`,
    };
}

function resolveModelOutput(output: ResolveOutput): string {
    if (output.status === 'nothing_pending') {
        return output.message;
    }
    const parts = [output.message];
    if (output.applied !== undefined) {
        for (const entry of output.applied) {
            parts.push(`  ${entry.path}: ${entry.count}`);
        }
    }
    if (output.proposedCount !== undefined && output.applied !== undefined) {
        const appliedTotal = output.applied.reduce((sum, entry) => sum + entry.count, 0);
        parts.push(`proposed=${output.proposedCount} applied=${appliedTotal}`);
    }
    return parts.join('\n');
}
