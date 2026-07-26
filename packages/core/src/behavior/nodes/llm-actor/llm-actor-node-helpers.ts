import type { AbgNodeSpec } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ConversationSummary } from '../../../context/compaction';
import type { Blackboard } from '../../../memory/blackboard';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types';
import { type ParseStructuredOutputResult, type StructuredOutputShape } from '../../structured-blackboard';
import { readStringConfig } from '../composite-node-utils';
import { expandCapabilityLabels } from './capability-expand';
import type { LlmActorTurnResult } from './llm-actor-node';

export { CAPABILITY_EXPAND, expandCapabilityLabels } from './capability-expand';

/**
 * Advertise only tools whose `capabilityClasses` intersect the node's allowed set.
 *
 * Semantics (OpenCode-aligned):
 * - `undefined` capabilities → advertise everything (coding-agent graph default).
 * - empty `[]` → advertise nothing (pure structured gates).
 * - non-empty → expand coarse labels via {@link expandCapabilityLabels}, then exact-match
 *   against each tool's registered classes. Execution is still gated by approval/permission.
 */
export function filterByCapabilities(
    advertisements: readonly ToolAdvertisement[],
    capabilities: readonly string[] | undefined,
): readonly ToolAdvertisement[] {
    if (capabilities === undefined) return advertisements;
    if (capabilities.length === 0) return [];
    const capabilitySet = expandCapabilityLabels(capabilities);
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

/** Free-text format contract for hybrid outputKey nodes (not pure generate_object gates). */
export function buildStructuredOutputContract(node: AbgNodeSpec, outputKey: string): string {
    const shape = readOutputShape(node);
    const outputEnum = readOutputEnum(node);
    const allowed =
        outputEnum !== undefined
            ? outputEnum.map((entry) => `\`${entry}\``).join(' | ')
            : shape === 'boolean'
              ? '`true` | `false`'
              : shape === 'array'
                ? 'a JSON array'
                : shape === 'object'
                  ? 'a JSON object'
                  : shape === 'string'
                    ? 'a single-line string token'
                    : 'a whole exact structured value (JSON, boolean, or single-line string)';
    return (
        `STRUCTURED OUTPUT CONTRACT for key "${outputKey}":\n` +
        `Your entire response must be exactly ${allowed} and nothing else.\n` +
        'No prose, no markdown fences, no tool calls, no continuation of prior exploration, no explanation.'
    );
}

export function readOutputKey(node: AbgNodeSpec): string | undefined {
    return readStringConfig(node, 'outputKey');
}

export function readOutputEnum(node: AbgNodeSpec): readonly string[] | undefined {
    const { outputEnum: value } = node.config ?? {};
    if (!Array.isArray(value)) return undefined;
    const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : undefined;
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
