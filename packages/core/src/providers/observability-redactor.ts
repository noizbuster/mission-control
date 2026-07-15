import { type AbgSignal, AbgSignalSchema } from '@mission-control/protocol';
import { OBSERVABILITY_UNAVAILABLE, type ObservabilityRedactor } from './observability-value-redactor.js';

export {
    redactAgentEventEnvelopeForObservability,
    redactAgentEventForObservability,
} from './observability-event-redactor.js';
export { redactProviderChunkForObservability } from './observability-provider-chunk.js';
export {
    composeObservabilityRedactors,
    createObservabilityRedactor,
    OBSERVABILITY_CIRCULAR,
    OBSERVABILITY_REDACTION_MAX_BYTES,
    OBSERVABILITY_REDACTION_MAX_DEPTH,
    OBSERVABILITY_REDACTION_MAX_ENTRIES,
    OBSERVABILITY_TRUNCATED,
    OBSERVABILITY_UNAVAILABLE,
    type ObservabilityRedactor,
    type ObservabilityRedactorOptions,
    type ObservabilityTextStream,
} from './observability-value-redactor.js';

export function redactAbgSignalForObservability(signal: AbgSignal, redactor: ObservabilityRedactor): AbgSignal {
    const parsed = AbgSignalSchema.safeParse(redactor.redactValue(signal));
    if (parsed.success) {
        return parsed.data;
    }
    const nodeId = redactor.redactText(signal.nodeId) || OBSERVABILITY_UNAVAILABLE;
    const graphId = signal.graphId === undefined ? undefined : redactor.redactText(signal.graphId);
    return {
        type: 'failure',
        nodeId,
        ...(graphId !== undefined && graphId.length > 0 ? { graphId } : {}),
        error: OBSERVABILITY_UNAVAILABLE,
    };
}
