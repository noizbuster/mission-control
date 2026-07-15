import type { AbgNodeSpec } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ConversationSummary } from '../../../context/compaction';
import type { Blackboard } from '../../../memory/blackboard';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types';
import { type ParseStructuredOutputResult, type StructuredOutputShape } from '../../structured-blackboard';
import type { LlmActorTurnResult } from './llm-actor-node';

export function readStringConfig(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function filterByCapabilities(
    advertisements: readonly ToolAdvertisement[],
    capabilities: readonly string[] | undefined,
): readonly ToolAdvertisement[] {
    if (capabilities === undefined) return advertisements;
    if (capabilities.length === 0) return [];
    const capabilitySet = new Set(capabilities);
    return advertisements.filter((advertisement) =>
        advertisement.capabilityClasses.some((capability) => capabilitySet.has(capability)),
    );
}

export function readOutputShape(node: AbgNodeSpec): StructuredOutputShape {
    const value = readStringConfig(node, 'outputShape');
    if (value === 'object' || value === 'array' || value === 'boolean' || value === 'string' || value === 'any') {
        return value;
    }
    return 'any';
}

export function applyEnumConstraint(
    node: AbgNodeSpec,
    parsed: ParseStructuredOutputResult,
): ParseStructuredOutputResult {
    if (!parsed.ok) return parsed;
    const outputEnum = readOutputEnum(node);
    if (outputEnum === undefined) return parsed;
    if (typeof parsed.value === 'string' && outputEnum.includes(parsed.value)) return parsed;
    return {
        ok: false,
        error: `output for outputKey not in declared outputEnum ${JSON.stringify(outputEnum)}: ${JSON.stringify(parsed.value)}`,
    };
}

export function readPriorSummary(blackboard: Blackboard): ConversationSummary | undefined {
    const value = blackboard.get('context.summary');
    if (value === undefined || value === null || typeof value !== 'object') return undefined;
    if (!('goal' in value) || !('summarizedMessageCount' in value)) return undefined;
    return value as ConversationSummary;
}

export function extractTurnResult(result: unknown): LlmActorTurnResult | undefined {
    if (result === null || typeof result !== 'object' || !('responseMessages' in result)) return undefined;
    const candidate = result as { text?: unknown; usage?: unknown; responseMessages?: unknown };
    if (!Array.isArray(candidate.responseMessages)) return undefined;
    return {
        text: typeof candidate.text === 'string' ? candidate.text : '',
        usage: candidate.usage,
        responseMessages: candidate.responseMessages as readonly ModelMessage[],
    };
}

function readOutputEnum(node: AbgNodeSpec): readonly string[] | undefined {
    const { outputEnum: value } = node.config ?? {};
    if (!Array.isArray(value)) return undefined;
    const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : undefined;
}
