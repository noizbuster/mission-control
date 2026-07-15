import { describe, expect, it } from 'vitest';
import { probeSessionControlProcess } from './session-control-process';

describe('session control process identity', () => {
    it('proves a macOS or BSD prior owner stale from process start evidence without signaling it', async () => {
        // Given
        const readProcessStartId = async (pid: number) => (pid === 404_404 ? 'new-process-start' : undefined);

        // When
        const state = await probeSessionControlProcess(404_404, 'old-process-start', {
            platform: 'darwin',
            readProcessStartId,
        });

        // Then
        expect(state).toBe('mismatched');
    });

    it('does not grant takeover when macOS or BSD process evidence still matches', async () => {
        // Given
        const readProcessStartId = async () => 'same-process-start';

        // When
        const state = await probeSessionControlProcess(404_404, 'same-process-start', {
            platform: 'freebsd',
            readProcessStartId,
        });

        // Then
        expect(state).toBe('matching');
    });

    it('fails closed when platform process inspection itself is unavailable', async () => {
        // Given
        const readProcessStartId = async (): Promise<string | undefined> => {
            throw new Error('process inspection unavailable');
        };

        // When
        const state = await probeSessionControlProcess(404_404, 'old-process-start', {
            platform: 'darwin',
            readProcessStartId,
        });

        // Then
        expect(state).toBe('unknown');
    });
});
