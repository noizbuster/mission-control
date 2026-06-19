/**
 * ABG tool bridge: adapts a mission-control `ToolRegistry` tool into a Vercel AI SDK
 * tool whose `execute` first crosses the ABG policy gate, then runs the real registry
 * invoke path (version check, JSON parse, schema validation, output bounding, events).
 *
 * This is the §5.2 seam. The AI SDK owns tool dispatch, but execution is intercepted:
 *   llm.tool_call.proposed (emitted by the adapter)
 *     -> policyGate(toolCallId, toolName, argumentsJson)   [awaits a decision]
 *     -> on allow:  ToolRegistry.invoke(...)  -> tool.completed
 *     -> on deny:   returns a BLOCKED tool result (no effect on the workspace)
 *
 * Because the SDK only continues the turn after `execute` resolves (and the LLMActor
 * node pins `stopWhen: stepCountIs(1)` — see llm-actor-node.ts), the policy gate is a
 * true runtime gate, not a race.
 *
 * Tool failures are surfaced to the model (not swallowed as '') so it can read the
 * error, adjust, and retry — the persona's own instruction.
 */

import type { AgentEvent, ProtocolError, ToolResultStatus } from '@mission-control/protocol';
import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import type { ToolRegistry } from '../../../tools/tool-registry.js';
import type { ToolAdvertisement, ToolInvocationSettlement } from '../../../tools/tool-registry-types.js';

export class AbgToolBridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbgToolBridgeError';
    }
}

/**
 * A minimal async mutex used to serialize a tool BATCH on the INTERACTIVE graph path. `acquire()`
 * resolves once every prior acquisition has released; the resolved callback releases the lock. One
 * instance is shared across every bridged tool in a turn (created by `bridgeAdvertisementsToAiSdk`)
 * so the AI-SDK's concurrent tool dispatch is reduced to one-at-a-time execution — keeping the
 * interactive approval broker's single-pending invariant (a 2nd concurrent approval would otherwise
 * auto-deny). Non-interactive graph runs do not use it, preserving the batch's parallel execution.
 */
type ToolExecutionLock = {
    readonly acquire: () => Promise<() => void>;
};

function createAsyncMutex(): ToolExecutionLock {
    // A FIFO promise chain: each `acquire()` appends a "hold" promise to the tail and resolves
    // with a release callback that ends that hold. The next waiter's `.then` only runs once the
    // previous hold resolves, so holders run strictly one after the other.
    let chain: Promise<unknown> = Promise.resolve();
    return {
        acquire: () =>
            new Promise<() => void>((resolveAcquire) => {
                chain = chain.then(
                    () =>
                        new Promise<void>((resolveHold) => {
                            resolveAcquire(() => resolveHold());
                        }),
                );
            }),
    };
}

export type PolicyGateDecision = {
    readonly allowed: boolean;
    readonly reason?: string;
};

export type PolicyGateInput = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
};

export type PolicyGateFn = (input: PolicyGateInput) => Promise<PolicyGateDecision>;

export type PolicyDecisionObserverInput = PolicyGateDecision & {
    readonly toolCallId: string;
    readonly toolName: string;
};

/**
 * The authoritative outcome of one bridged tool call, mirroring the settlement the flat
 * provider path persists on its `toolResult` AgentEvent. The adapter turns this into the
 * `tool.completed`/`tool.failed` ABG emit so a graph session's coding-step replay carries
 * the SAME status/output/error detail a flat session does (true parity, not just ids).
 */
export type AbgToolSettlement = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: ToolResultStatus;
    readonly output?: unknown;
    /**
     * The tool's structured output object (e.g. `{ kind: 'file_patch', appliedFiles }`) — the SAME field
     * the flat path persists as `settlement.structuredOutput` and renders `Applied patch:`/`Applied edit:`/
     * `Created file:` from. Threaded into the ledger so the adapter can carry it on the `tool.completed`
     * emit and the graph renderer recovers the detail the model-facing `output` string loses.
     */
    readonly structuredOutput?: unknown;
    readonly error?: ProtocolError;
};

/**
 * A per-turn ledger the bridge writes (on settle) and the stream-part adapter reads (on the
 * SDK's `tool-result` part). The SDK's `tool-result` part fires only AFTER `execute` resolves,
 * so the entry is always recorded before the adapter looks it up — the ledger is the bridge
 * for the adapter to recover the settlement's true status (the SDK collapses a failed
 * settlement to a `tool-result` carrying an error string, since the bridge surfaces failures
 * to the model as readable text; the ledger restores the structured `failed` status).
 *
 * `approvalBlockedSettlement` lets the LLMActor detect a tool that settled as
 * `approval_required` (a permission gate with no automation, in `block` mode) and short-circuit
 * the graph to a `blocked` settle instead of surfacing the block to the model — which would
 * otherwise retry the same call until the loop budget is exhausted. This mirrors the flat run
 * prior flat run coordinator's `approvalBlockedSettlement` detection.
 */
export type AbgToolSettlementLedger = {
    readonly record: (settlement: AbgToolSettlement) => void;
    readonly lookup: (toolCallId: string) => AbgToolSettlement | undefined;
    readonly approvalBlockedSettlement: () => AbgToolSettlement | undefined;
    readonly deniedSettlement: () => AbgToolSettlement | undefined;
    readonly terminalFailedSettlement: () => AbgToolSettlement | undefined;
};

export function createAbgToolSettlementLedger(): AbgToolSettlementLedger {
    const entries = new Map<string, AbgToolSettlement>();
    return {
        record: (settlement) => {
            entries.set(settlement.toolCallId, settlement);
        },
        lookup: (toolCallId) => entries.get(toolCallId),
        approvalBlockedSettlement: () => {
            for (const settlement of entries.values()) {
                if (isApprovalRequiredSettlement(settlement)) {
                    return settlement;
                }
            }
            return undefined;
        },
        deniedSettlement: () => {
            for (const settlement of entries.values()) {
                if (isApprovalDeniedSettlement(settlement)) {
                    return settlement;
                }
            }
            return undefined;
        },
        terminalFailedSettlement: () => {
            for (const settlement of entries.values()) {
                if (isTerminalFailedSettlement(settlement)) {
                    return settlement;
                }
            }
            return undefined;
        },
    };
}

/**
 * A settlement is approval-blocked when the registry invoked the tool through the permission
 * gate, the gate decided `requires_approval` with no automation, and the tool surfaced an
 * `approval_required` error. The registry wraps EVERY tool error as `ProtocolError{code:
 * 'tool_failed', message: '<tool-code>: <detail>'}` (see file-patch-errors.ts
 * `filePatchFailure`), so the discriminator is the MESSAGE PREFIX, not the `code` — exactly
 * how the flat run coordinator detects it (`isApprovalBlockedMessage`). `approval_denied:`
 * (a denial) is NOT a block — it is a terminal failure the graph surfaces as `failed`.
 */
export function isApprovalRequiredSettlement(settlement: AbgToolSettlement): boolean {
    return settlement.status === 'failed' && (settlement.error?.message ?? '').startsWith('approval_required:');
}

/**
 * A settlement is approval-denied when the permission gate decided `deny` and the tool surfaced
 * an `approval_denied` error (message prefix; the registry wraps every tool error as code
 * `tool_failed`). A denial is terminal — the graph surfaces it as a non-retryable `failed` run
 * (parity with the flat run coordinator's `terminalFailedSettlement`), so the model does not loop
 * retrying a denied call.
 */
export function isApprovalDeniedSettlement(settlement: AbgToolSettlement): boolean {
    return settlement.status === 'failed' && (settlement.error?.message ?? '').startsWith('approval_denied:');
}

/**
 * A settlement is a terminal tool failure when it settled `failed` for a reason that is NEITHER an
 * approval block NOR a denial — e.g. `command_not_allowed` (a hard tool-policy block: the command
 * is not allowlisted, so the model cannot fix it by retrying). When `haltOnFailedToolSettlement`
 * is enabled, the LLMActor short-circuits the graph to a terminal `failed` run on such a settlement
 * instead of surfacing it to the model — parity with the flat run coordinator's
 * `terminalFailedSettlement` (removed), which failed the run on the first
 * non-approval tool failure rather than looping until the tool-call continuation limit.
 */
export function isTerminalFailedSettlement(settlement: AbgToolSettlement): boolean {
    return (
        settlement.status === 'failed' &&
        !isApprovalRequiredSettlement(settlement) &&
        !isApprovalDeniedSettlement(settlement) &&
        settlement.error?.retryable !== true
    );
}

export type AbgToolBridgeOptions = {
    readonly policyGate?: PolicyGateFn;
    readonly onPolicyDecision?: (decision: PolicyDecisionObserverInput) => void;
    readonly settlementLedger?: AbgToolSettlementLedger;
    /**
     * Forwards a tool's own `settlement.events` (file.diff.applied, command.run lifecycle, ...) into
     * the graph event stream — parity with the flat run loop's `settleToolCalls`, which appends them.
     * Tool-lifecycle events the adapter already synthesizes (tool.started/completed/failed) are
     * filtered so they are not double-emitted; the adapter owns the graph-canonical tool lifecycle.
     */
    readonly onToolEvent?: (event: AgentEvent) => void;
    /**
     * Serialize a proposed tool BATCH: when true, `bridgeAdvertisementsToAiSdk` creates ONE shared
     * mutex so the AI-SDK's concurrent tool dispatch runs one `execute` at a time within a turn. The
     * INTERACTIVE graph path needs this — the interactive approval broker allows a single pending
     * approval, so a parallel batch would auto-deny a 2nd concurrent approval. Omitted (the default)
     * leaves tools parallel, which non-interactive graph runs rely on for batched tool execution.
     */
    readonly serializeToolExecution?: boolean;
};

/**
 * Build an AI SDK `ToolSet` from advertised tools, each wrapped with the policy-gate seam. When
 * `options.serializeToolExecution` is set, ONE shared mutex is created here and handed to every
 * tool so a batch proposed in a single step executes one tool at a time (interactive approval
 * parity) instead of concurrently.
 */
export function bridgeAdvertisementsToAiSdk(
    registry: ToolRegistry,
    advertisements: readonly ToolAdvertisement[],
    options: AbgToolBridgeOptions = {},
): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    const lock = options.serializeToolExecution === true ? createAsyncMutex() : undefined;
    for (const advertisement of advertisements) {
        tools[advertisement.name] = bridgeAdvertisementToAiSdk(registry, advertisement, options, lock);
    }
    return tools;
}

export function bridgeAdvertisementToAiSdk(
    registry: ToolRegistry,
    advertisement: ToolAdvertisement,
    options: AbgToolBridgeOptions = {},
    lock?: ToolExecutionLock,
): Tool {
    const inputSchema = jsonSchema(
        assertJsonSchema(advertisement.name, advertisement.providerTool.parametersJsonSchema),
    );
    return tool({
        description: advertisement.description,
        inputSchema,
        execute: async (args, execOptions) => {
            const toolCallId = execOptions.toolCallId;
            const argumentsJson = JSON.stringify(args ?? {});
            const signal = execOptions.abortSignal;
            const ledger = options.settlementLedger;
            // Serialize tool execution within a batch when a shared lock is present (interactive
            // graph path): acquire BEFORE crossing the policy gate / registry invoke so at most one
            // approval is pending at a time. No lock (non-interactive) → the SDK runs the batch
            // concurrently, unchanged.
            const release = lock !== undefined ? await lock.acquire() : undefined;
            try {
                if (options.policyGate !== undefined) {
                    const decision = await options.policyGate({
                        toolCallId,
                        toolName: advertisement.name,
                        argumentsJson,
                    });
                    options.onPolicyDecision?.({ ...decision, toolCallId, toolName: advertisement.name });
                    if (!decision.allowed) {
                        const blockMessage = `BLOCKED by policy gate${decision.reason !== undefined ? `: ${decision.reason}` : ''}`;
                        // A denied call never reaches the registry, so synthesize the settlement:
                        // the adapter must see a `failed` outcome (not a bare `tool-result`) so the
                        // replay shows the block. `unknown` is the honest code — there is no
                        // `blocked` ProtocolErrorCode.
                        ledger?.record({
                            toolCallId,
                            toolName: advertisement.name,
                            status: 'failed',
                            error: { code: 'unknown', message: blockMessage, retryable: false },
                        });
                        return blockMessage;
                    }
                }

                const settlement = await registry.invoke({
                    toolCallId,
                    toolName: advertisement.name,
                    advertisedVersion: advertisement.version,
                    argumentsJson,
                    ...(signal !== undefined ? { signal } : {}),
                });

                // Record the authoritative settlement BEFORE returning, so the adapter (which sees
                // the SDK's `tool-result` part only after this resolves) can emit the true
                // status/output/error. Distinct from the model-facing return below: failures are
                // surfaced to the model as a readable error string (persona contract), but the
                // ledger records the structured error so the replay marks the tool failed.
                ledger?.record(settlementToLedgerEntry(toolCallId, advertisement.name, settlement));

                // Forward the tool's own events (file.diff.applied, command lifecycle, ...) into the
                // graph stream — parity with the flat run loop's settleToolCalls. The adapter owns the
                // graph-canonical tool.started/completed/failed, so skip those here to avoid duplicates.
                if (options.onToolEvent !== undefined) {
                    for (const event of settlement.events) {
                        if (!isAdapterOwnedToolLifecycle(event.type)) {
                            options.onToolEvent(event);
                        }
                    }
                }

                if (settlement.modelOutput !== undefined) {
                    return settlement.modelOutput.content;
                }
                if (settlement.result.status !== 'failed' && settlement.result.output !== undefined) {
                    return settlement.result.output;
                }
                // Failed settlement: surface the ProtocolError so the model can adjust/retry
                // instead of receiving an empty, indistinguishable-from-success result.
                const error = settlement.result.error;
                const code = error?.code ?? 'tool_failed';
                const message = error?.message ?? 'tool produced no model output';
                return `Tool "${advertisement.name}" failed (${code}): ${message}`;
            } finally {
                release?.();
            }
        },
    });
}

/**
 * Extract the ledger entry from a registry settlement — the SAME fields the flat path persists
 * on its `toolResult` AgentEvent (`result.output` for completed, `result.error` for failed), so
 * the graph coding-step replay matches the flat path's detail exactly.
 */
function settlementToLedgerEntry(
    toolCallId: string,
    toolName: string,
    settlement: ToolInvocationSettlement,
): AbgToolSettlement {
    const result = settlement.result;
    if (result.status === 'completed') {
        return {
            toolCallId,
            toolName,
            status: 'completed',
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(settlement.structuredOutput !== undefined ? { structuredOutput: settlement.structuredOutput } : {}),
        };
    }
    return {
        toolCallId,
        toolName,
        status: 'failed',
        error: result.error ?? {
            code: 'tool_failed',
            message: 'tool produced no model output',
            retryable: false,
        },
    };
}

/**
 * Tool-lifecycle event types the stream-part adapter synthesizes from the settlement ledger
 * (tool.started/completed/failed). The bridge forwards a tool's own settlement.events EXCEPT
 * these, so the adapter remains the single source for the graph-canonical tool lifecycle and the
 * tool's richer events (file.diff.applied, command output, ...) flow through unchanged.
 */
function isAdapterOwnedToolLifecycle(eventType: AgentEvent['type']): boolean {
    return eventType === 'tool.started' || eventType === 'tool.completed' || eventType === 'tool.failed';
}

/**
 * Guard the `Record<string, unknown>` → `JSONSchema7` narrowing. The registry stores
 * parametersJsonSchema as an unvalidated record; fail fast (at bridge build) with a clear
 * error if it isn't JSON-Schema-shaped, rather than forwarding garbage to the provider.
 */
function assertJsonSchema(name: string, schema: Readonly<Record<string, unknown>>): JSONSchema7 {
    const looksLikeJsonSchema =
        'type' in schema ||
        '$ref' in schema ||
        'enum' in schema ||
        'allOf' in schema ||
        'anyOf' in schema ||
        'oneOf' in schema;
    if (!looksLikeJsonSchema) {
        throw new AbgToolBridgeError(
            `Tool "${name}" parametersJsonSchema is not a valid JSON Schema (expected one of: type, $ref, enum, allOf, anyOf, oneOf)`,
        );
    }
    return schema as JSONSchema7;
}
