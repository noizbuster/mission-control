import type { AgentEvent, ProtocolError } from '@mission-control/protocol';
import { ToolExecutionError } from './tool-registry-types.js';

export type CommandRunFailureCode =
    | 'approval_denied'
    | 'approval_required'
    | 'command_not_allowed'
    | 'command_failed'
    | 'command_spawn_failed'
    | 'command_timed_out'
    | 'concurrency_limit';

export function commandRunFailure(
    code: CommandRunFailureCode,
    message: string,
    events: readonly AgentEvent[] = [],
): ToolExecutionError {
    return new ToolExecutionError(protocolError(`${code}: ${message}`), events);
}

function protocolError(message: string): ProtocolError {
    return {
        code: 'tool_failed',
        message,
        retryable: false,
    };
}
