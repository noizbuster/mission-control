/**
 * Adapts Mission Control tool advertisements to Vercel AI SDK tool schemas.
 *
 * The legacy bridge keeps inline SDK execution for direct callers and compatibility tests. The
 * graph path uses `createProposalOnlyToolBridge`, so its provider stream reaches a terminal model
 * response before graph-owned registry settlement starts.
 */

import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import type { ToolRegistry } from '../../../tools/tool-registry';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types';
import {
    type AbgToolBridgeOptions,
    type CapturedToolProposal,
    createToolProposalExecutor,
    type ToolProposalExecutor,
} from './abg-tool-proposal-execution';

export {
    type AbgToolBridgeOptions,
    type AbgToolSettlement,
    type AbgToolSettlementLedger,
    type CapturedToolProposal,
    createAbgToolSettlementLedger,
    type ExecutedToolProposal,
    isApprovalDeniedSettlement,
    isApprovalRequiredSettlement,
    isTerminalFailedSettlement,
    type PolicyDecisionObserverInput,
    type PolicyGateDecision,
    type PolicyGateFn,
} from './abg-tool-proposal-execution';

export class AbgToolBridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbgToolBridgeError';
    }
}

export type ProposalOnlyToolBridge = {
    readonly tools: Record<string, Tool>;
    readonly execute: ToolProposalExecutor['execute'];
};

/**
 * Build tools that the SDK can advertise but cannot execute. The graph settles proposals only
 * after the provider stream ends, keeping the stream's chunk deadline provider-scoped.
 */
export function createProposalOnlyToolBridge(
    registry: ToolRegistry,
    advertisements: readonly ToolAdvertisement[],
    options: AbgToolBridgeOptions = {},
): ProposalOnlyToolBridge {
    return {
        tools: schemaOnlyTools(advertisements),
        execute: createToolProposalExecutor(registry, advertisements, options, 'proposal-only').execute,
    };
}

/**
 * Legacy inline-execution bridge. Keep this export for non-graph callers and focused bridge
 * tests; graph LLM actors must use `createProposalOnlyToolBridge`.
 */
export function bridgeAdvertisementsToAiSdk(
    registry: ToolRegistry,
    advertisements: readonly ToolAdvertisement[],
    options: AbgToolBridgeOptions = {},
): Record<string, Tool> {
    const executor = createToolProposalExecutor(registry, advertisements, options);
    const tools: Record<string, Tool> = {};
    for (const advertisement of advertisements) {
        tools[advertisement.name] = bridgeAdvertisementWithExecutor(advertisement, executor);
    }
    return tools;
}

export function bridgeAdvertisementToAiSdk(
    registry: ToolRegistry,
    advertisement: ToolAdvertisement,
    options: AbgToolBridgeOptions = {},
): Tool {
    return bridgeAdvertisementWithExecutor(
        advertisement,
        createToolProposalExecutor(registry, [advertisement], options),
    );
}

function schemaOnlyTools(advertisements: readonly ToolAdvertisement[]): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const advertisement of advertisements) {
        tools[advertisement.name] = schemaOnlyTool(advertisement);
    }
    return tools;
}

function bridgeAdvertisementWithExecutor(advertisement: ToolAdvertisement, executor: ToolProposalExecutor): Tool {
    const inputSchema = jsonSchema(
        assertJsonSchema(advertisement.name, advertisement.providerTool.parametersJsonSchema),
    );
    return tool({
        description: advertisement.description,
        inputSchema,
        execute: async (args, options) => {
            const proposal: CapturedToolProposal = {
                toolCallId: options.toolCallId,
                toolName: advertisement.name,
                argumentsJson: JSON.stringify(args ?? {}),
            };
            const settled = await executor.execute([proposal], options.abortSignal);
            const first = settled[0];
            if (first === undefined) {
                throw new AbgToolBridgeError(`tool proposal did not settle: ${advertisement.name}`);
            }
            return first.modelOutput;
        },
    });
}

function schemaOnlyTool(advertisement: ToolAdvertisement): Tool {
    return tool({
        description: advertisement.description,
        inputSchema: jsonSchema(assertJsonSchema(advertisement.name, advertisement.providerTool.parametersJsonSchema)),
    });
}

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
