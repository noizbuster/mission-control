import type { AgentEvent } from '@mission-control/protocol';
import { type DesktopApprovalEffectRecord, sameDesktopApprovalEffect } from './desktop-approval-effect';
import { fixedNow } from './desktop-session-commands-test-support';
import { toolCallsFromEvents } from './desktop-tool-approval-authority';
import type { DesktopApprovalStore } from './desktop-tool-approvals';

export type MemoryApprovalStore = DesktopApprovalStore & {
    readonly events: readonly AgentEvent[];
};

export function createMemoryApprovalStore(initialEvents: readonly AgentEvent[]): MemoryApprovalStore {
    const events: AgentEvent[] = [...initialEvents];
    const effects = new Map<string, DesktopApprovalEffectRecord>();
    return {
        events,
        append: async (event) => {
            events.push(event);
        },
        getEvents: async () => [...events],
        getDesktopApprovalToolCall: async (toolCallId) => {
            const matches = toolCallsFromEvents(events).filter((toolCall) => toolCall.toolCallId === toolCallId);
            const first = matches[0];
            if (
                first === undefined ||
                matches.some(
                    (toolCall) =>
                        toolCall.toolName !== first.toolName || toolCall.argumentsJson !== first.argumentsJson,
                )
            ) {
                return undefined;
            }
            return first;
        },
        reserveDesktopApprovalEffect: async (effect) => {
            const existing = effects.get(effect.approvalId);
            if (existing !== undefined) {
                return existing.state === 'pending' && sameDesktopApprovalEffect(existing.effect, effect);
            }
            effects.set(effect.approvalId, { effect, state: 'pending', requestedAt: fixedNow() });
            return true;
        },
        claimDesktopApprovalEffect: async (input) => {
            const now = fixedNow();
            if (input.leaseExpiresAt <= now) {
                throw new TypeError('desktop approval effect execution lease must expire after the claim time');
            }
            const existing = effects.get(input.effect.approvalId);
            if (existing === undefined) return { status: 'missing' };
            if (!sameDesktopApprovalEffect(existing.effect, input.effect)) return { status: 'identity_mismatch' };
            switch (existing.state) {
                case 'pending': {
                    const claimed = {
                        effect: input.effect,
                        state: 'executing',
                        executionToken: input.executionToken,
                        leaseExpiresAt: input.leaseExpiresAt,
                        requestedAt: existing.requestedAt,
                        executingAt: now,
                    } as const;
                    effects.set(input.effect.approvalId, claimed);
                    return { status: 'claimed', record: claimed };
                }
                case 'executing':
                    if (existing.leaseExpiresAt > now) return { status: 'executing', record: existing };
                    effects.set(input.effect.approvalId, { ...existing, state: 'unknown', unknownAt: now });
                    return {
                        status: 'unknown',
                        record: { ...existing, state: 'unknown', unknownAt: now },
                    };
                case 'settled':
                    return { status: 'settled', record: existing };
                case 'unknown':
                    return { status: 'unknown', record: existing };
                default:
                    return assertNeverEffectRecord(existing);
            }
        },
        settleDesktopApprovalEffect: async (input) => {
            const settledAt = fixedNow();
            const existing = effects.get(input.effect.approvalId);
            if (
                existing?.state !== 'executing' ||
                existing.executionToken !== input.executionToken ||
                existing.leaseExpiresAt <= settledAt ||
                !sameDesktopApprovalEffect(existing.effect, input.effect)
            ) {
                return false;
            }
            effects.set(input.effect.approvalId, {
                ...existing,
                state: 'settled',
                outcome: input.outcome,
                settledAt,
            });
            return true;
        },
        getDesktopApprovalEffect: async (approvalId) => effects.get(approvalId),
        resolveDesktopApprovalEffect: async (input) => {
            const existing = effects.get(input.approvalId);
            if (existing?.state !== 'unknown') return undefined;
            if (existing.outcome !== undefined) return existing.outcome === input.outcome ? existing : undefined;
            const resolved = { ...existing, outcome: input.outcome, resolvedAt: input.resolvedAt } as const;
            effects.set(input.approvalId, resolved);
            return resolved;
        },
    };
}

function assertNeverEffectRecord(record: never): never {
    throw new TypeError(`Unexpected desktop approval effect record: ${JSON.stringify(record)}`);
}
