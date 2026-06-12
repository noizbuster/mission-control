import { type AgentEvent, type SidecarWireResponse, SidecarWireResponseSchema } from '@mission-control/protocol';
import { SidecarProtocolError } from './sidecar-errors.js';

export function normalizeSidecarLine(line: string, sessionId?: string): AgentEvent {
    return sidecarResponseToAgentEvent(parseSidecarWireResponse(line), sessionId);
}

export function parseSidecarWireResponse(line: string): SidecarWireResponse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new SidecarProtocolError(`sidecar response is not valid JSON: ${error.message}`);
        }
        throw error;
    }

    const result = SidecarWireResponseSchema.safeParse(parsed);
    if (!result.success) {
        throw new SidecarProtocolError('sidecar response failed protocol validation');
    }
    return result.data;
}

export function sidecarResponseToAgentEvent(response: SidecarWireResponse, sessionId?: string): AgentEvent {
    switch (response.type) {
        case 'handshake_completed':
            return {
                type: 'native.status',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: `sidecar protocol v${String(response.protocolVersion)} capabilities: ${response.capabilities.join(', ')}`,
                nativeSidecarStatus: 'native',
            };
        case 'task_progress': {
            return {
                type: 'task.progress',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                progress: response.progress,
                nativeSidecarStatus: 'native',
            };
        }
        case 'task_completed': {
            return {
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: response.result.message,
                nativeSidecarStatus: 'native',
            };
        }
        case 'task_failed': {
            return {
                type: 'task.failed',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: `${response.error.code}: ${response.error.message}`,
                nativeSidecarStatus: 'native',
            };
        }
        case 'task_cancelled': {
            return {
                type: 'task.failed',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: `sidecar task cancelled: ${response.reason}`,
                nativeSidecarStatus: 'native',
            };
        }
        default:
            return assertNever(response);
    }
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected sidecar response: ${JSON.stringify(value)}`);
}
