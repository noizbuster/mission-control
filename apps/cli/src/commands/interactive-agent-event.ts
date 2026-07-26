import type { AgentEvent } from '@mission-control/protocol';

/**
 * Builds an {@link AgentEvent} from the caller-supplied fields, injecting a
 * live `timestamp`. Callers pass `type` plus whatever subset of the schema's
 * optional fields their event carries (typically `sessionId`, `message`,
 * `modelProviderSelection`, and an event-specific payload); the timestamp is
 * the only field this centralises, keeping every emitted event consistent.
 *
 * The {@link AgentEventSchema} remains the source of truth — this helper only
 * removes the boilerplate of stamping `new Date().toISOString()` at every
 * construction site.
 */
export function buildAgentEvent(base: Omit<AgentEvent, 'timestamp'>): AgentEvent {
    return { ...base, timestamp: new Date().toISOString() };
}
