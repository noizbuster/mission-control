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

/**
 * Only `command_not_allowed` (a hard tool-policy block) is non-retryable: the model cannot fix
 * it by retrying. All other codes are model-recoverable so `haltOnFailedToolSettlement` surfaces
 * them instead of killing the run — a single nonzero exit must not terminate the whole session.
 */
const NON_RETRYABLE_COMMAND_CODES: ReadonlySet<CommandRunFailureCode> = new Set(['command_not_allowed']);

export function commandRunFailure(
    code: CommandRunFailureCode,
    message: string,
    events: readonly AgentEvent[] = [],
): ToolExecutionError {
    const retryable = !NON_RETRYABLE_COMMAND_CODES.has(code);
    return new ToolExecutionError(protocolError(`${code}: ${message}`, retryable), events);
}

function protocolError(message: string, retryable: boolean = false): ProtocolError {
    return {
        code: 'tool_failed',
        message,
        retryable,
    };
}
