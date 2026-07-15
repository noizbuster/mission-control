export const legacySessionImportConflictCodes = ['sequence_collision', 'event_id_collision'] as const;
export type LegacySessionImportConflictCode = (typeof legacySessionImportConflictCodes)[number];

export class LegacySessionImportConflictError extends Error {
    readonly name = 'LegacySessionImportConflictError';

    constructor(
        readonly code: LegacySessionImportConflictCode,
        readonly sessionId: string,
        readonly sequence: number,
        readonly eventId: string,
    ) {
        super(
            code === 'sequence_collision'
                ? `Legacy session ${sessionId} sequence ${sequence} has different canonical content`
                : `Legacy event id ${eventId} has different canonical content`,
        );
    }
}
