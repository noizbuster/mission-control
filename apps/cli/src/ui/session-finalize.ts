/**
 * Session finalize status line.
 *
 * Every `mc` session termination path emits exactly one finalize line so the
 * user can observe how the session ended (`complete`, `aborted`, or `failed`)
 * with an optional reason for the non-complete cases.
 *
 * The finalize info is surfaced in two channels:
 *   1. A durable `session.finalize` AgentEvent persisted to the session store
 *      so `/resume`, `/session <sid>`, `mc session show`, and `mc session replay`
 *      can render it.
 *   2. A live plain-text line on stdout for PlainRenderer/TuiRenderer (and on
 *      stderr for JsonRenderer so the stdout JSON event stream stays clean
 *      until the synthetic event lands via the normal render path).
 */

import type { AgentEvent, NativeSidecarStatus, SessionFinalizeEventMetadata } from '@mission-control/protocol';

export type SessionFinalStatus = 'complete' | 'aborted' | 'failed';

export type SessionFinalizeInfo = {
    readonly status: SessionFinalStatus;
    readonly reason?: string;
};

export function formatSessionFinalizeLine(status: SessionFinalStatus, reason?: string): string {
    const prefix = `Session ${status}`;
    if (reason === undefined || reason.length === 0) {
        return prefix;
    }
    return `${prefix}: ${reason}`;
}

export function formatSessionFinalizeLineFromInfo(info: SessionFinalizeInfo): string {
    return formatSessionFinalizeLine(info.status, info.reason);
}

export function toSessionFinalizeEventMetadata(info: SessionFinalizeInfo): SessionFinalizeEventMetadata {
    return {
        status: info.status,
        ...(info.reason !== undefined && info.reason.length > 0 ? { reason: info.reason } : {}),
    };
}

export function createSessionFinalizeEvent(
    info: SessionFinalizeInfo,
    options: {
        readonly timestamp: string;
        readonly sessionId?: string;
        readonly nativeSidecarStatus?: NativeSidecarStatus;
    },
): AgentEvent {
    return {
        type: 'session.finalize',
        timestamp: options.timestamp,
        message: formatSessionFinalizeLineFromInfo(info),
        sessionFinalize: toSessionFinalizeEventMetadata(info),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.nativeSidecarStatus !== undefined ? { nativeSidecarStatus: options.nativeSidecarStatus } : {}),
    };
}
