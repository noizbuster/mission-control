/**
 * Mid-Conversation System Message emission.
 *
 * A Mid-Conversation System Message is a durable chronological instruction that
 * tells the model the newly effective state of a changed Context Source. Per
 * CONTEXT.md, changes from multiple Context Sources admitted at one Safe
 * Provider-Turn Boundary combine into one system message, and newly promoted
 * user input or settled tool results precede any combined message.
 *
 * This module bridges the `SystemContextRegistry` algebra to the protocol's
 * `AgentMessage` system-role shape so the provider turn runner can admit context
 * updates at safe boundaries.
 */
import type { AgentMessage } from '@mission-control/protocol';
import type { SystemContextRegistry } from './system-context-source.js';

/** A system-role message matching the protocol's `AgentMessage` discriminated union. */
export type SystemMessage = Extract<AgentMessage, { readonly role: 'system' }>;

/** Result of a mid-conversation emission: zero or one system messages plus the new epoch. */
export interface MidConversationEmitResult {
    readonly messages: readonly SystemMessage[];
    readonly newEpoch: number;
}

/**
 * Emits durable Mid-Conversation System Messages at a Safe Provider-Turn Boundary.
 *
 * Observes all registered Context Sources, compares them against the last-admitted
 * snapshots, and if any source changed, returns exactly one system message
 * combining all update texts. The epoch advances when changes are admitted.
 *
 * Call this immediately before a provider call, after durable input promotion
 * and any required tool settlement.
 */
export async function emitMidConversationSystemMessage(
    registry: SystemContextRegistry,
    epoch: number,
): Promise<MidConversationEmitResult> {
    const { updates, newEpoch } = await registry.getUpdatesSince(epoch);
    if (updates.length === 0) {
        return { messages: [], newEpoch };
    }
    return {
        messages: [{ role: 'system', content: updates.join('\n\n') }],
        newEpoch,
    };
}
