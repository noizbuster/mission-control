/**
 * Full-parity `task()` CLI factory (todo 25).
 *
 * Switches the CLI tool registries from the simple `task(description, prompt)`
 * tool to the full-parity `task()` tool (`task/task-tool.ts`). Builds a
 * `ConcreteTaskToolRuntime` (todo 22) with a spawn adapter over
 * `spawnChildCodingAgent`, wraps the registration with a `subagent` permission
 * gate, and applies a backward-compat shim: legacy `task(description, prompt)`
 * calls are translated to `task(agent: 'deep', assignment: prompt)` via a
 * `z.preprocess` stage before full-parity schema validation.
 *
 * The simple `createTaskToolRegistration` stays available in
 * `task-tool-factory.ts`; its deprecation is Wave 6 todo 34.
 */
import type {
    AbgNodeModelOptions,
    AgentDefinition,
    PermissionDecision,
    PermissionRequest,
    ProtocolError,
} from '@mission-control/protocol';
import { z } from 'zod';
import { parseAgentFile } from '../agents/agent-parser.js';
import { AgentIndex } from '../agents/agent-registry.js';
import { BUNDLED_AGENT_TEMPLATES } from '../agents/bundled/index.js';
import type { ModelPattern } from '../agents/model-resolver.js';
import { ConcreteTaskToolRuntime, type SpawnFn } from '../agents/task-tool-runtime.js';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child.js';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver.js';
import {
    createFullParityTaskToolRegistration,
    type TaskToolParams,
    type TaskToolResult,
    taskToolInputSchema,
} from './task/task-tool.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import type { ToolAdvertisement } from './tool-registry.js';
import { ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';

export type FullParityTaskToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly resolveSdkModel: SdkModelResolver;
    readonly model: AbgNodeModelOptions;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentSessionId?: string;
    readonly summaryLimit?: number;
    readonly agentIndex?: AgentIndex;
    readonly parentAgent?: AgentDefinition;
};

export async function registerFullParityTaskTool(
    registry: ToolRegistry,
    options: FullParityTaskToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createFullParityTaskToolRegistrationForCli(options));
}

export async function createFullParityTaskToolRegistrationForCli(
    options: FullParityTaskToolOptions,
): Promise<ToolRegistration<TaskToolParams, TaskToolResult>> {
    const agentIndex = options.agentIndex ?? buildBundledAgentIndex();
    const parentAgent: AgentDefinition = options.parentAgent ?? {
        name: 'coding-agent',
        description: 'Mission Control coding agent',
        systemPrompt: '',
        source: 'bundled',
    };
    const resolveModel = (_agent: AgentDefinition): ModelPattern => ({
        providerID: options.model.providerID,
        modelID: options.model.modelID,
        ...(options.model.variantID !== undefined ? { variantID: options.model.variantID } : {}),
    });
    const spawnFn: SpawnFn = async (context) => {
        const modelOptions: AbgNodeModelOptions = {
            providerID: context.model.providerID,
            modelID: context.model.modelID,
            ...(context.model.variantID !== undefined ? { variantID: context.model.variantID } : {}),
        };
        const taskOutput = await spawnChildCodingAgent({
            description: context.agent.name,
            prompt: context.prompt,
            resolveSdkModel: options.resolveSdkModel,
            model: modelOptions,
            parentToolRegistry: context.childToolRegistry,
            now: () => new Date().toISOString(),
            sessionId: context.sessionId,
            ...(options.summaryLimit !== undefined ? { summaryLimit: options.summaryLimit } : {}),
        });
        return { sessionId: context.sessionId, status: taskOutput.status, output: taskOutput.summary };
    };

    const base = createFullParityTaskToolRegistration({
        runtime: new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel,
            workspaceRoot: options.workspaceRoot,
            parentToolRegistry: options.parentToolRegistry,
            parentAgent,
            spawnFn,
        }),
    });

    const cliInputSchema = z.preprocess(translateLegacyTaskInput, taskToolInputSchema);
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
    const baseProps = base.parametersJsonSchema['properties'];
    const cliParametersJsonSchema: Record<string, unknown> = {
        ...base.parametersJsonSchema,
        properties: {
            ...(isObject(baseProps) ? baseProps : {}),
            description: {
                type: 'string',
                description: 'Legacy compat: short label. Maps to agent=deep, assignment=prompt.',
            },
        },
    };

    return {
        ...base,
        parametersJsonSchema: cliParametersJsonSchema,
        inputSchema: cliInputSchema,
        guideline:
            'Delegate a sub-task to a child agent session. Route by category or agent for preset ' +
            'model/tools/permissions (deep=full, explore=read-only, ultrabrain=opus). Children ' +
            'cannot spawn nested tasks. Legacy task(description, prompt) maps to ' +
            'task(agent=deep, assignment=prompt). Pass tasks[] for batch fan-out.',
        execute: async (input, context) => {
            const reason = input.prompt ?? input.assignment ?? 'subagent delegation';
            await requireFullParitySubagentPermission(options, context.toolCallId, reason);
            return base.execute(input, context);
        },
    };
}

function buildBundledAgentIndex(): AgentIndex {
    const index = new AgentIndex();
    for (const template of BUNDLED_AGENT_TEMPLATES) {
        try {
            index.register(parseAgentFile('<bundled>', template, 'bundled'));
        } catch {
            void 0;
        }
    }
    return index;
}

/**
 * Backward-compat shim for legacy `task(description, prompt)`: translates to
 * `task(agent: 'deep', assignment: prompt)`. oh-my-pi convention: description
 * becomes role label, prompt becomes assignment. Strips description before
 * full-parity schema validation (which is `.strict()`).
 */
function translateLegacyTaskInput(raw: unknown): unknown {
    if (!isObject(raw)) return raw;
    const obj: Record<string, unknown> = { ...raw };
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
    if (typeof obj['description'] !== 'string') return raw;
    const hasNewRouting =
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        obj['agent'] !== undefined ||
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        obj['category'] !== undefined ||
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        obj['subagent_type'] !== undefined;
    if (!hasNewRouting) {
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        const prompt = obj['prompt'];
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        delete obj['description'];
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        delete obj['prompt'];
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        obj['agent'] = 'deep';
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
        if (typeof prompt === 'string') obj['assignment'] = prompt;
        return obj;
    }
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
    delete obj['description'];
    return obj;
}

async function requireFullParitySubagentPermission(
    options: FullParityTaskToolOptions,
    toolCallId: string,
    reason: string,
): Promise<void> {
    const request = permissionRequest({
        toolCallId,
        action: 'task',
        reason: `delegate sub-task: ${reason}`,
        permission: 'subagent',
        patterns: [reason],
        workspaceRoot: options.workspaceRoot,
    });
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') return;
    const code = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    const error: ProtocolError = {
        code: 'tool_failed',
        message: `${code}: ${decision.reason ?? `approval refused: ${decision.status}`}`,
        retryable: false,
    };
    throw new ToolExecutionError(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
