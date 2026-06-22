/**
 * Permission-self-gating `task` factory + CLI spawn builder.
 *
 * Mirrors the webfetch factory: the graph engine bridges tool advertisements to the AI SDK
 * WITHOUT a `policyGate` (`llm-actor-node-runner.ts`), so the `task` tool gates on the graph
 * path only by baking `requestPermission` into its own `execute`. Before delegating it requests
 * a `subagent` permission (reason = the delegated description) and, on denial, surfaces
 * `approval_required`/`approval_denied` the way the file/webfetch tools do so the LLMActor
 * settlement-ledger detects it and the run enters `blocked_on_approval` instead of spawning a
 * child. The flat-path interactive preflight covers only the preview; this execute gate is what
 * blocks on the graph path and in noninteractive `--no-tui` runs.
 *
 * `createTaskSpawnFn` wires the runtime half: it builds a `TaskSpawnFn` from
 * `spawnChildCodingAgent`, capturing the parent tool registry so the child surface is derived
 * via `createChildToolRegistry` (registry-layer recursion guard — the child never sees `task`
 * itself, and after the child-policy blocklist extension it never sees network/subagent caps
 * either).
 *
 * The full-parity factory (`registerFullParityTaskTool`) lives in
 * `task-tool-full-parity-factory.ts`; the simple `createTaskToolRegistration` here stays
 * available until its deprecation in Wave 6 todo 34.
 */
import type {
    AbgNodeModelOptions,
    PermissionDecision,
    PermissionRequest,
    ProtocolError,
} from '@mission-control/protocol';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child.js';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver.js';
import {
    type CreateTaskToolInput,
    createTaskToolRegistration,
    type TaskInput,
    type TaskOutput,
    type TaskSpawnFn,
} from './task-tool.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';

export type TaskToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly spawn: TaskSpawnFn;
    readonly summaryLimit?: number;
};

export async function registerTaskTool(registry: ToolRegistry, options: TaskToolOptions): Promise<ToolAdvertisement> {
    return registry.register(await createTaskToolRegistrationForCli(options));
}

/**
 * Wrap the static `createTaskToolRegistration` with a `subagent` permission gate baked into
 * `execute`. Denial throws `ToolExecutionError` carrying `approval_required`/`approval_denied` so
 * the settlement ledger detects the block; the child spawn is never reached on denial.
 */
export async function createTaskToolRegistrationForCli(
    options: TaskToolOptions,
): Promise<ToolRegistration<TaskInput, TaskOutput>> {
    const baseInput: CreateTaskToolInput = {
        spawn: options.spawn,
        ...(options.summaryLimit !== undefined ? { summaryLimit: options.summaryLimit } : {}),
    };
    const base = createTaskToolRegistration(baseInput);
    return {
        ...base,
        guideline:
            'Delegate self-contained read-only sub-tasks to a child agent. The child surface excludes destructive, network, and subagent tools, so it cannot run bash/write, fetch URLs, or spawn further tasks. Use for isolated research or analysis.',
        execute: async (input, context) => {
            await requireSubagentPermission(options, context.toolCallId, input.description);
            return base.execute(input, context);
        },
    };
}

async function requireSubagentPermission(
    options: TaskToolOptions,
    toolCallId: string,
    description: string,
): Promise<void> {
    const request = permissionRequest({
        toolCallId,
        action: 'task',
        reason: `delegate sub-task: ${description}`,
        permission: 'subagent',
        patterns: [description],
        workspaceRoot: options.workspaceRoot,
    });
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') {
        return;
    }
    const code = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    throw taskFailure(code, decision.reason ?? `approval refused: ${decision.status}`);
}

function taskFailure(code: 'approval_denied' | 'approval_required', message: string): ToolExecutionError {
    const error: ProtocolError = {
        code: 'tool_failed',
        message: `${code}: ${message}`,
        retryable: false,
    };
    return new ToolExecutionError(error);
}

/**
 * Context for building a real `TaskSpawnFn` over `spawnChildCodingAgent`. The
 * `parentToolRegistry` is captured by reference; the child surface is derived lazily at spawn
 * time via `createChildToolRegistry`, so it reflects the fully-populated parent registry.
 */
export type TaskToolSpawnContext = {
    readonly resolveSdkModel: SdkModelResolver;
    readonly model: AbgNodeModelOptions;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentSessionId?: string;
    readonly summaryLimit?: number;
};

/**
 * Build a `TaskSpawnFn` that runs a real child coding-agent graph. Each invocation mints a unique
 * child session id (counter-prefixed by the parent session) so child runs are distinguishable in
 * durable logs. Reuses `spawnChildCodingAgent`'s bounded budget/limits.
 */
export function createTaskSpawnFn(context: TaskToolSpawnContext): TaskSpawnFn {
    let childCounter = 0;
    const prefix = context.parentSessionId ?? 'task';
    return async (input, spawnContext) => {
        childCounter += 1;
        return spawnChildCodingAgent({
            description: input.description,
            prompt: input.prompt,
            resolveSdkModel: context.resolveSdkModel,
            model: context.model,
            parentToolRegistry: context.parentToolRegistry,
            now: () => new Date().toISOString(),
            sessionId: `${prefix}_child_${childCounter}`,
            ...(context.summaryLimit !== undefined ? { summaryLimit: context.summaryLimit } : {}),
            ...(spawnContext.signal !== undefined ? { signal: spawnContext.signal } : {}),
        });
    };
}
