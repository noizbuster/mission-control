import type { AbgGraphRunResult } from '../behavior/graph-runner.js';
import { redactModelMessagesForObservability } from './model-message-observability.js';
import { redactAgentEventForObservability } from './observability-event-redactor.js';
import type { ObservabilityRedactor } from './observability-value-redactor.js';

export function redactGraphRunResultForObservability(
    result: AbgGraphRunResult,
    redactor: ObservabilityRedactor,
): AbgGraphRunResult {
    return {
        ...result,
        graphId: redactor.redactText(result.graphId),
        events: result.events.map((event) => redactAgentEventForObservability(event, redactor)),
        ...(result.finalMessages !== undefined
            ? { finalMessages: redactModelMessagesForObservability(result.finalMessages, redactor) }
            : {}),
        ...(result.terminalError !== undefined
            ? {
                  terminalError: {
                      ...result.terminalError,
                      code: redactor.redactText(result.terminalError.code),
                      message: redactor.redactText(result.terminalError.message),
                  },
              }
            : {}),
        ...(result.toolCallId !== undefined ? { toolCallId: redactor.redactIdentifier(result.toolCallId) } : {}),
        ...(result.reason !== undefined ? { reason: redactor.redactText(result.reason) } : {}),
    };
}
