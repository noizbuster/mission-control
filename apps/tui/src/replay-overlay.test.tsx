/** @jsxImportSource @opentui/solid */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@opentui/solid', () => ({
    useKeyboard: () => undefined,
    useTerminalDimensions: () => () => ({ width: 80, height: 24 }),
}));
vi.mock('./components/AbgOverlay', () => ({ AbgOverlay: () => undefined }));
vi.mock('./platform/opentui-renderer', () => ({ mountOpenTui: vi.fn() }));

import { mountOpenTui } from './platform/opentui-renderer';
import { runReplayOverlay } from './replay-overlay';

describe('runReplayOverlay', () => {
    it('rejects when the deferred OpenTUI mount fails', async () => {
        const mountError = new Error('native renderer unavailable');
        vi.mocked(mountOpenTui).mockRejectedValueOnce(mountError);

        await expect(
            runReplayOverlay({
                sessionId: 'session-replay',
                envelopes: [],
            }),
        ).rejects.toBe(mountError);
    });
});
