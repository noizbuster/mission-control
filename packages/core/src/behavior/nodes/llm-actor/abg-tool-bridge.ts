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

import type { ProtocolError, ToolResultStatus } from '@mission-control/protocol';
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
    readonly error?: ProtocolError;
};

/**
 * A per-turn ledger the bridge writes (on settle) and the stream-part adapter reads (on the
 * SDK's `tool-result` part). The SDK's `tool-result` part fires only AFTER `execute` resolves,
 * so the entry is always recorded before the adapter looks it up — the ledger is the bridge
 * for the adapter to recover the settlement's true status (the SDK collapses a failed
 * settlement to a `tool-result` carrying an error string, since the bridge surfaces failures
 * to the model as readable text; the ledger restores the structured `failed` status).
 */
export type AbgToolSettlementLedger = {
    readonly record: (settlement: AbgToolSettlement) => void;
    readonly lookup: (toolCallId: string) => AbgToolSettlement | undefined;
};

export function createAbgToolSettlementLedger(): AbgToolSettlementLedger {
    const entries = new Map<string, AbgToolSettlement>();
    return {
        record: (settlement) => {
            entries.set(settlement.toolCallId, settlement);
        },
        lookup: (toolCallId) => entries.get(toolCallId),
    };
}

export type AbgToolBridgeOptions = {
    readonly policyGate?: PolicyGateFn;
    readonly onPolicyDecision?: (decision: PolicyDecisionObserverInput) => void;
    readonly settlementLedger?: AbgToolSettlementLedger;
};

/**
 * Build an AI SDK `ToolSet` from advertised tools, each wrapped with the policy-gate seam.
 */
export function bridgeAdvertisementsToAiSdk(
    registry: ToolRegistry,
    advertisements: readonly ToolAdvertisement[],
    options: AbgToolBridgeOptions = {},
): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const advertisement of advertisements) {
        tools[advertisement.name] = bridgeAdvertisementToAiSdk(registry, advertisement, options);
    }
    return tools;
}

export function bridgeAdvertisementToAiSdk(
    registry: ToolRegistry,
    advertisement: ToolAdvertisement,
    options: AbgToolBridgeOptions = {},
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

            if (options.policyGate !== undefined) {
                const decision = await options.policyGate({ toolCallId, toolName: advertisement.name, argumentsJson });
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
