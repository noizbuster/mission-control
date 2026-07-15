import type { AgentEvent } from '@mission-control/protocol';
import { type ObservabilityRedactor, redactAgentEventForObservability } from '../providers/observability-redactor.js';
import { ToolExecutionError } from './tool-registry-types.js';

export function redactBrowserToolError(
    error: ToolExecutionError,
    observabilityRedactor: ObservabilityRedactor,
): ToolExecutionError {
    const redactions = error.error.redactions?.map((metadata) => ({
        ...metadata,
        reason: observabilityRedactor.redactText(metadata.reason),
        replacement: observabilityRedactor.redactText(metadata.replacement),
    }));
    return new ToolExecutionError(
        {
            ...error.error,
            message: observabilityRedactor.redactText(error.error.message),
            ...(redactions === undefined ? {} : { redactions }),
        },
        error.events.map((event: AgentEvent) => redactAgentEventForObservability(event, observabilityRedactor)),
    );
}
