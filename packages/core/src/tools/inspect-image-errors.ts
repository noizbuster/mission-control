import type { ProtocolError } from '@mission-control/protocol';
import { ToolExecutionError } from './tool-registry';

export function inspectFailure(message: string): ToolExecutionError {
    const error: ProtocolError = { code: 'tool_failed', message, retryable: false };
    return new ToolExecutionError(error);
}

export function inspectErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
