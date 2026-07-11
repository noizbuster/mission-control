import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';

export function inputProjectionStatements(envelopes: readonly AgentEventEnvelope[]): readonly InStatement[] {
    return envelopes.flatMap((envelope) => {
        const transcript = envelope.event.transcript;
        if (transcript?.inputId === undefined) {
            return [];
        }
        switch (envelope.event.type) {
            case 'prompt.admitted':
                if (transcript.delivery === undefined) {
                    return [];
                }
                return [
                    {
                        sql: `
                            INSERT INTO session_inputs (
                                input_id, session_id, delivery, status, prompt, admitted_seq,
                                created_at, admitted_at, metadata_json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(input_id) DO UPDATE SET
                                session_id = excluded.session_id,
                                delivery = excluded.delivery,
                                status = excluded.status,
                                prompt = excluded.prompt,
                                admitted_seq = excluded.admitted_seq,
                                admitted_at = excluded.admitted_at,
                                promoted_seq = NULL,
                                promoted_at = NULL,
                                cancelled_at = NULL,
                                metadata_json = excluded.metadata_json
                        `,
                        args: [
                            transcript.inputId,
                            envelope.sessionId,
                            transcript.delivery,
                            'admitted',
                            envelope.event.message ?? '',
                            envelope.sequence,
                            envelope.event.timestamp,
                            envelope.event.timestamp,
                            JSON.stringify({ messageId: transcript.messageId ?? null }),
                        ],
                    },
                ];
            case 'prompt.promoted':
                return [
                    {
                        sql: `
                            UPDATE session_inputs
                            SET status = ?, promoted_seq = ?, promoted_at = ?, cancelled_at = NULL
                            WHERE input_id = ? AND session_id = ? AND status IN (?, ?)
                        `,
                        args: [
                            'promoted',
                            envelope.sequence,
                            envelope.event.timestamp,
                            transcript.inputId,
                            envelope.sessionId,
                            'pending',
                            'admitted',
                        ],
                    },
                ];
            case 'prompt.cancelled':
                return [
                    {
                        sql: `
                            UPDATE session_inputs
                            SET status = ?, cancelled_at = ?, metadata_json = ?
                            WHERE input_id = ? AND session_id = ? AND status IN (?, ?)
                        `,
                        args: [
                            'cancelled',
                            envelope.event.timestamp,
                            JSON.stringify({
                                requestId: transcript.requestId ?? null,
                                reason: transcript.reason ?? null,
                            }),
                            transcript.inputId,
                            envelope.sessionId,
                            'pending',
                            'admitted',
                        ],
                    },
                ];
            default:
                return [];
        }
    });
}
