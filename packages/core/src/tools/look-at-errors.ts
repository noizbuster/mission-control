import type { ProtocolError } from '@mission-control/protocol';
import { ToolExecutionError } from './tool-registry';

export function lookAtFailure(message: string, retryable: boolean): ToolExecutionError {
    const error: ProtocolError = { code: 'tool_failed', message, retryable };
    return new ToolExecutionError(error);
}

export function lookAtErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
