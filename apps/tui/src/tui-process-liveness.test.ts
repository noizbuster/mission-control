import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainTuiProcessLiveness } from './tui-process-liveness';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('retainTuiProcessLiveness', () => {
    it('keeps the Node event loop referenced until released', () => {
        const intervalSpy = vi.spyOn(global, 'setInterval');
        const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
        const release = retainTuiProcessLiveness();
        const timer = intervalSpy.mock.results[0]?.value;

        try {
            if (
                typeof timer !== 'object' ||
                timer === null ||
                !('hasRef' in timer) ||
                typeof timer.hasRef !== 'function'
            ) {
                throw new Error('expected a Node timer handle');
            }
            expect(timer.hasRef()).toBe(true);
        } finally {
            release();
        }

        if (typeof timer !== 'object' || timer === null || !('hasRef' in timer) || typeof timer.hasRef !== 'function') {
            throw new Error('expected a Node timer handle');
        }
        expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    });
});
