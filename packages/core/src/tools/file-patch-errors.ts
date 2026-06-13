import type { AgentEvent, ProtocolError } from '@mission-control/protocol';
import { ToolExecutionError } from './tool-registry-types.js';

export type FilePatchFailureCode =
    | 'approval_denied'
    | 'approval_required'
    | 'edit_not_found'
    | 'edit_not_unique'
    | 'binary_file'
    | 'dirty_target'
    | 'git_status_failed'
    | 'not_file'
    | 'patch_apply_failed'
    | 'patch_parse_failed'
    | 'patch_too_large'
    | 'partial_failed'
    | 'target_exists'
    | 'workspace_denied'
    | 'workspace_escape'
    | 'write_failed';

export function filePatchFailure(
    code: FilePatchFailureCode,
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
