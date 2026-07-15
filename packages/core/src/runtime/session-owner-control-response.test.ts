import { describe, expect, it, vi } from 'vitest';
import { trackSessionOwnerControlStopResponse } from './session-owner-control-response';
import { EventEmitter } from 'node:events';

describe('session owner control stop response tracking', () => {
    it('finishes exactly once when the client closes before the write callback', () => {
        // Given
        const connection = new EventEmitter();
        const finish = vi.fn();
        const written = trackSessionOwnerControlStopResponse(connection, finish);

        // When
        connection.emit('close');
        written();

        // Then
        expect(finish).toHaveBeenCalledOnce();
    });
});
