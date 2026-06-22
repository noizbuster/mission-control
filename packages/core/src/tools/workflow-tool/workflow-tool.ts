/**
 * `workflow` tool — Task 3.10.
 *
 * Lets the model self-invoke a named workflow by name + prompt. The tool resolves
 * the workflow name via the injected `WorkflowRegistry` (Task 2.1) and signals
 * intent. For v1 the tool resolves + returns; the runtime adapter (wired
 * separately) routes the resolved `spec.graph` through the same prompt-turn
 * lifecycle as `#name` invocation. The tool itself NEVER executes a real graph
 * run — it validates, resolves, and returns a status.
 *
 * Mirrors the skill tool's name-lookup + helpful-available-names pattern and the
 * task tool's thin-contract shape. `not_found` is a RETURNED status (not thrown)
 * so the model can read the available-names hint and retry with a corrected name.
 *
 * Capability class `'workflow'` is in `CHILD_DROPPED_CAPABILITY_KINDS`, so child
 * registries built via `createChildToolRegistry` do not expose this tool — that
 * prevents a delegated child from self-invoking a workflow graph and recursing
 * back into the runtime adapter.
 */
import type { WorkflowSpec } from '@mission-control/protocol';
import { z } from 'zod';
import type { WorkflowRegistry } from '../../workflows/workflow-registry.js';
import type { ToolRegistry } from '../tool-registry.js';
import { type ToolAdvertisement, type ToolRegistration } from '../tool-registry-types.js';

/** The canonical tool name so recursion guards and registry lookups avoid magic strings. */
export const WORKFLOW_TOOL_NAME = 'workflow';

const WORKFLOW_OUTPUT_LIMIT = { maxModelOutputChars: 2000 } as const;

export const workflowInputSchema = z
    .object({
        name: z
            .string()
            .min(1)
            .describe('The workflow name, as shown in the <available_workflows> block of the system prompt.'),
        prompt: z.string().min(1).describe('The full prompt to run through the workflow graph.'),
    })
    .strict();

const workflowOutputSchema = z
    .object({
        status: z.enum(['started', 'not_found']),
        workflowName: z.string(),
        message: z.string(),
    })
    .strict();

export type WorkflowToolParams = z.infer<typeof workflowInputSchema>;
export type WorkflowToolResult = z.infer<typeof workflowOutputSchema>;

export type WorkflowToolOptions = {
    readonly registry: WorkflowRegistry;
};

/**
 * Build the `workflow` tool registration. The `registry` closure captures the
 * discovered workflow set so the tool's `execute` (which only receives
 * `toolCallId`/`toolName`/`signal`) can resolve the name without additional
 * runtime wiring.
 */
export function createWorkflowToolRegistration(
    options: WorkflowToolOptions,
): ToolRegistration<WorkflowToolParams, WorkflowToolResult> {
    return {
        name: WORKFLOW_TOOL_NAME,
        description:
            'Invoke a named workflow by name. The workflow runs its graph with the given prompt. ' +
            'Use for structured task execution patterns (planner, runner, autopilot). ' +
            `Known workflows: ${formatAvailableWorkflowNames(options.registry)}.`,
        capabilityClasses: ['workflow'],
        guideline:
            'Use the workflow tool to self-invoke a named workflow shown in <available_workflows>. ' +
            'Pass the workflow name and the prompt to run through it. Do not guess workflow names.',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'The workflow name, as shown in <available_workflows>.',
                },
                prompt: {
                    type: 'string',
                    description: 'The full prompt to run through the workflow graph.',
                },
            },
            required: ['name', 'prompt'],
            additionalProperties: false,
        },
        inputSchema: workflowInputSchema,
        outputSchema: workflowOutputSchema,
        outputLimit: WORKFLOW_OUTPUT_LIMIT,
        execute: (input) => resolveWorkflow(options.registry, input),
        toModelOutput: (output) => output.message,
    };
}

/** Convenience wrapper: build + register in one call, mirroring the skill/task pattern. */
export function registerWorkflowTool(registry: ToolRegistry, options: WorkflowToolOptions): ToolAdvertisement {
    return registry.register(createWorkflowToolRegistration(options));
}

function resolveWorkflow(registry: WorkflowRegistry, input: WorkflowToolParams): WorkflowToolResult {
    const spec = registry.lookup(input.name);
    if (spec === undefined) {
        return {
            status: 'not_found',
            workflowName: input.name,
            message: `Unknown workflow: ${input.name}. Available workflows: ${formatAvailableWorkflowNames(registry)}.`,
        };
    }
    return {
        status: 'started',
        workflowName: spec.name,
        message: buildStartedMessage(spec, input.prompt),
    };
}

function buildStartedMessage(spec: WorkflowSpec, prompt: string): string {
    const description = spec.description !== undefined && spec.description.length > 0 ? `: ${spec.description}` : '';
    const promptPreview = truncatePreview(prompt, 80);
    return (
        `Workflow "${spec.name}" started${description}. ` +
        `The runtime will execute the workflow graph with prompt: ${promptPreview}.`
    );
}

function truncatePreview(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Format the registry's workflow names for display in tool descriptions and
 * `not_found` messages. Names are XML-escaped so workflow names containing
 * `<`, `>`, or `&` cannot break the `<available_workflows>` system-prompt block
 * or inject markup into tool advertisements.
 */
function formatAvailableWorkflowNames(registry: WorkflowRegistry): string {
    const names = registry.names();
    if (names.length === 0) {
        return '(none discovered)';
    }
    return names.slice(0, 20).map(escapeXml).join(', ');
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
