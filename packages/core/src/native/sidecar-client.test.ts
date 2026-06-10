import { describe, expect, it } from 'vitest';
import { normalizeSidecarLine } from './sidecar-client.js';

describe('sidecar response normalization', () => {
    it('normalizes sidecar JSONL responses to protocol events', () => {
        const handshake = normalizeSidecarLine(
            '{"type":"handshake_completed","id":"handshake_1","protocolVersion":1,"capabilities":["task.run"]}',
            'session_1',
        );
        const progress = normalizeSidecarLine('{"type":"task_progress","id":"task_1","progress":0.25}', 'session_1');
        const completed = normalizeSidecarLine(
            '{"type":"task_completed","id":"task_1","result":{"message":"completed by rust sidecar"}}',
            'session_1',
        );

        expect(handshake).toMatchObject({
            type: 'native.status',
            sessionId: 'session_1',
            taskId: 'handshake_1',
            nativeSidecarStatus: 'native',
        });
        expect(progress).toMatchObject({
            type: 'task.progress',
            sessionId: 'session_1',
            taskId: 'task_1',
            progress: 0.25,
        });
        expect(completed).toMatchObject({
            type: 'task.completed',
            sessionId: 'session_1',
            taskId: 'task_1',
            message: 'completed by rust sidecar',
        });
    });
});
