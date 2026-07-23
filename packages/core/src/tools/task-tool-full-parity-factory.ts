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
import { AgentParseError, parseAgentFile } from '../agents/agent-parser';
import { AgentIndex } from '../agents/agent-registry';
import { BUNDLED_AGENT_TEMPLATES } from '../agents/bundled/index';
import {
    DEFAULT_ROLE_CONFIG,
    type ModelPattern,
    type ResolveAgentModelInput,
    resolveAgentModel,
} from '../agents/model-resolver';
import type { ModelRole } from '../agents/model-roles';
import { ConcreteTaskToolRuntime, type TaskToolRuntimeServices } from '../agents/task-tool-runtime';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver';
import {
    createFullParityTaskToolRegistration,
    type TaskToolParams,
    type TaskToolResult,
    taskToolInputSchema,
} from './task/task-tool';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import type { ToolAdvertisement } from './tool-registry';
import { ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';

export type FullParityTaskToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly resolveSdkModel: SdkModelResolver;
    /** Session-default model used when no parent or agent-specific tier resolves. */
    readonly model: AbgNodeModelOptions;
    /** Active parent model, when it differs from the session default. */
    readonly parentActiveModel?: AbgNodeModelOptions;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentSessionId?: string;
    readonly isCliRootParent?: true;
    readonly summaryLimit?: number;
    readonly agentIndex?: AgentIndex;
    readonly parentAgent?: AgentDefinition;
    readonly agentModelOverrides?: ReadonlyMap<string, ModelPattern>;
    readonly roleConfig?: Partial<Record<ModelRole, ModelPattern>>;
    readonly services?: TaskToolRuntimeServices;
    /**
     * Optional host-callback bag forwarded into the {@linkcode ConcreteTaskToolRuntime} so the
     * child graph can route ask_user / events / signals back to the parent TUI. When omitted
     * the child runs isolated; ask_user returns the `ASK_USER_BLOCKED_ANSWER` sentinel.
     */
    readonly hostCallbacks?: ChildHostCallbacks;
};

/**
 * Model-resolution closure for the full-parity task tool. All precedence,
 * including exact `mctrl/task` inheritance, is owned by
 * {@linkcode resolveAgentModel}; this adapter only supplies factory inputs.
 */
export function buildResolveModelFn(options: {
    readonly model: AbgNodeModelOptions;
    readonly parentActiveModel?: AbgNodeModelOptions;
    readonly agentModelOverrides?: ReadonlyMap<string, ModelPattern>;
    readonly roleConfig?: Partial<Record<ModelRole, ModelPattern>>;
}): (agent: AgentDefinition) => ModelPattern {
    const sessionDefault = toModelPattern(options.model);
    const parentActiveModel =
        options.parentActiveModel === undefined ? undefined : toModelPattern(options.parentActiveModel);
    return (agent: AgentDefinition): ModelPattern => {
        const agentModelOverride = options.agentModelOverrides?.get(agent.name);
        const resolverInput = {
            agent,
            sessionDefault,
            roleConfig: options.roleConfig ?? DEFAULT_ROLE_CONFIG,
            ...(parentActiveModel !== undefined ? { parentActiveModel } : {}),
        } satisfies ResolveAgentModelInput;
        return resolveAgentModel(
            agentModelOverride === undefined ? resolverInput : { ...resolverInput, agentModelOverride },
        );
    };
}

function toModelPattern(model: AbgNodeModelOptions): ModelPattern {
    return {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(model.variantID !== undefined ? { variantID: model.variantID } : {}),
    };
}

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
        spawns: '*',
    };
    const resolveModel = buildResolveModelFn(options);

    const base = createFullParityTaskToolRegistration({
        runtime: new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel,
            workspaceRoot: options.workspaceRoot,
            parentToolRegistry: options.parentToolRegistry,
            parentAgent,
            resolveSdkModel: options.resolveSdkModel,
            ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
            ...(options.isCliRootParent === true ? { isCliRootParent: true } : {}),
            ...(options.summaryLimit !== undefined ? { summaryLimit: options.summaryLimit } : {}),
            ...(options.services !== undefined ? { services: options.services } : {}),
            ...(options.hostCallbacks !== undefined ? { hostCallbacks: options.hostCallbacks } : {}),
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
            'model/tools/permissions (deep=full, explore=read-only, reasoner=opus). Nested task() ' +
            'is bounded to depth 3. Legacy task(description, prompt) maps to ' +
            'task(agent=deep, assignment=prompt). Pass tasks[] for batch fan-out.',
        execute: async (input, context) => {
            const reason = input.prompt ?? input.assignment ?? 'subagent delegation';
            await requireFullParitySubagentPermission(options, context.toolCallId, reason);
            return base.execute(input, context);
        },
    };
}

function buildBundledAgentIndex(): AgentIndex {
    return buildBundledAgentIndexFromTemplates({
        templates: BUNDLED_AGENT_TEMPLATES,
        parseAgent: (template) => parseAgentFile('<bundled>', template, 'bundled'),
        onRecoverableError: (error) => {
            process.stderr.write(`Skipping bundled agent template: ${error.message}\n`);
        },
    });
}

export function buildBundledAgentIndexFromTemplates(input: {
    readonly templates: readonly string[];
    readonly parseAgent: (template: string) => AgentDefinition;
    readonly onRecoverableError?: (error: AgentParseError) => void;
}): AgentIndex {
    const index = new AgentIndex();
    for (const template of input.templates) {
        try {
            index.register(input.parseAgent(template));
        } catch (error: unknown) {
            if (error instanceof AgentParseError) {
                input.onRecoverableError?.(error);
                continue;
            }
            throw error;
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
