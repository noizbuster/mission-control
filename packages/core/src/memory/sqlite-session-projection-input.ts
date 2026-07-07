import type { AgentEventEnvelope } from '@mission-control/protocol';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { z } from 'zod';
import type { SessionProjectionDiagnostic } from './session-projection-types.js';

export type ParsedSqliteProjectionInput =
    | { readonly kind: 'ok'; readonly envelopes: readonly AgentEventEnvelope[] }
    | { readonly kind: 'diagnostic'; readonly diagnostic: SessionProjectionDiagnostic };

export function parseSqliteProjectionInput(input: {
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly envelopes: readonly unknown[];
}): ParsedSqliteProjectionInput {
    const envelopes: AgentEventEnvelope[] = [];
    for (const envelope of input.envelopes) {
        const parsed = AgentEventEnvelopeSchema.safeParse(envelope);
        if (!parsed.success || parsed.data.sessionId !== input.sessionId) {
            return {
                kind: 'diagnostic',
                diagnostic: malformedDiagnostic(
                    input,
                    parsed.success ? 'session id mismatch' : zodMessage(parsed.error),
                ),
            };
        }
        envelopes.push(parsed.data);
    }
    return { kind: 'ok', envelopes };
}

function malformedDiagnostic(
    input: { readonly sessionId: string; readonly sourcePath: string },
    message: string,
): SessionProjectionDiagnostic {
    return {
        kind: 'corrupt_jsonl',
        sessionId: input.sessionId,
        filePath: input.sourcePath,
        code: 'unknown',
        message,
    };
}

function zodMessage(error: z.ZodError): string {
    const message = error.issues.map((issue) => issue.message).join('; ');
    return message.length > 0 ? message : 'malformed event payload';
}
