import { type JsonlSessionEventStoreError, jsonlStoreError } from './jsonl-errors.js';

export function sessionMismatch(sessionId: string, filePath: string): JsonlSessionEventStoreError {
    return jsonlStoreError({
        code: 'session_mismatch',
        message: `JSONL session log ${sessionId} cannot store an event for another session`,
        sessionId,
        path: filePath,
    });
}
