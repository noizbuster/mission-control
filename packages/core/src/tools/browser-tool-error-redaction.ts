import type { AgentEvent } from '@mission-control/protocol';
import { type ObservabilityRedactor, redactAgentEventForObservability } from '../providers/observability-redactor';
import { ToolExecutionError } from './tool-registry-types';

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
