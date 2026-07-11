import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';

export function cancelledWaitProjectionStatements(envelopes: readonly AgentEventEnvelope[]): readonly InStatement[] {
    const inputCreatedAt = new Map<string, string>();
    const statements: InStatement[] = [];
    for (const envelope of envelopes) {
        const event = envelope.event;
        const inputId = event.transcript?.inputId;
        if (event.type === 'prompt.admitted' && inputId !== undefined) {
            inputCreatedAt.set(inputId, event.timestamp);
        }
        if (event.type === 'prompt.cancelled' && inputId !== undefined) {
            statements.push(
                cancelledWaitStatement({
                    waitId: `input_wait_${inputId}`,
                    sessionId: envelope.sessionId,
                    reason: 'user_input',
                    sourceKind: 'operator',
                    sourceId: inputId,
                    createdAt: inputCreatedAt.get(inputId) ?? event.timestamp,
                    cancelledAt: event.timestamp,
                    metadata: {
                        requestId: event.transcript?.requestId ?? null,
                        reason: event.transcript?.reason ?? null,
                    },
                }),
            );
        }
        const approval = event.approvalRecord;
        if (event.type === 'approval.updated' && approval?.state === 'cancelled') {
            statements.push(
                cancelledWaitStatement({
                    waitId: approval.approvalId,
                    sessionId: envelope.sessionId,
                    reason: 'approval',
                    sourceKind: 'approval',
                    sourceId: approval.approvalId,
                    approvalId: approval.approvalId,
                    createdAt: approval.requestedAt,
                    cancelledAt: event.timestamp,
                    metadata: { requestId: approval.requestId, reason: approval.reason ?? null },
                }),
            );
        }
    }
    return statements;
}

function cancelledWaitStatement(input: {
    readonly waitId: string;
    readonly sessionId: string;
    readonly reason: 'approval' | 'user_input';
    readonly sourceKind: 'approval' | 'operator';
    readonly sourceId: string;
    readonly approvalId?: string;
    readonly createdAt: string;
    readonly cancelledAt: string;
    readonly metadata: Readonly<Record<string, string | null>>;
}): InStatement {
    return {
        sql: `
            INSERT INTO session_awaits (
                wait_id, session_id, reason, source_kind, source_id, approval_id,
                status, created_at, cancelled_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(wait_id) DO UPDATE SET
                status = excluded.status,
                resolved_at = NULL,
                cancelled_at = excluded.cancelled_at,
                metadata_json = excluded.metadata_json
        `,
        args: [
            input.waitId,
            input.sessionId,
            input.reason,
            input.sourceKind,
            input.sourceId,
            input.approvalId ?? null,
            'cancelled',
            input.createdAt,
            input.cancelledAt,
            JSON.stringify(input.metadata),
        ],
    };
}
