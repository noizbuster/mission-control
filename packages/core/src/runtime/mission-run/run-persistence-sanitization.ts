import { type Run, RunSchema } from '@mission-control/protocol';
import type { ObservabilityRedactor } from '../../providers/observability-redactor.js';
import { redactCredentialText } from '../../providers/redaction-handler.js';
import { TERMINAL_RUN_STATUSES } from './run-status-transitions.js';

export function sanitizeRunForPersistence(run: Run, observabilityRedactor?: ObservabilityRedactor): Run {
    const observableRun = RunSchema.parse(observabilityRedactor?.redactValue(run) ?? run);
    const { terminalReason, ...base } = observableRun;
    return RunSchema.parse({
        ...base,
        ...(TERMINAL_RUN_STATUSES.has(observableRun.status) && terminalReason !== undefined
            ? { terminalReason: sanitizeTerminalReason(terminalReason) }
            : {}),
    });
}

export function sanitizeTerminalReason(reason: string): string {
    return redactCredentialText(reason).slice(0, 4096);
}
