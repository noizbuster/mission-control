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

import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import type { ToolRegistry } from '../../../tools/tool-registry.js';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types.js';

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

export type AbgToolBridgeOptions = {
    readonly policyGate?: PolicyGateFn;
    readonly onPolicyDecision?: (decision: PolicyDecisionObserverInput) => void;
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

            if (options.policyGate !== undefined) {
                const decision = await options.policyGate({ toolCallId, toolName: advertisement.name, argumentsJson });
                options.onPolicyDecision?.({ ...decision, toolCallId, toolName: advertisement.name });
                if (!decision.allowed) {
                    return `BLOCKED by policy gate${decision.reason !== undefined ? `: ${decision.reason}` : ''}`;
                }
            }

            const settlement = await registry.invoke({
                toolCallId,
                toolName: advertisement.name,
                advertisedVersion: advertisement.version,
                argumentsJson,
                ...(signal !== undefined ? { signal } : {}),
            });

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
