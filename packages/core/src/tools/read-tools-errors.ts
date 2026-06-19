import type { ProtocolError } from '@mission-control/protocol';
import { ToolExecutionError } from './tool-registry-types.js';

export type RepoToolFailureCode =
    | 'workspace_escape'
    | 'workspace_denied'
    | 'not_found'
    | 'not_file'
    | 'not_directory'
    | 'binary_file'
    | 'read_failed'
    | 'search_failed';

export function repoToolFailure(code: RepoToolFailureCode, message: string): ToolExecutionError {
    return new ToolExecutionError(protocolError(`${code}: ${message}`));
}

function protocolError(message: string): ProtocolError {
    return {
        code: 'tool_failed',
        message,
        retryable: true,
    };
}
