import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { createFatalRenderEscapeHandler } from './AppShell';

describe('createFatalRenderEscapeHandler', () => {
    it('closes the imperative input queue exactly once after recovery circuit opens', async () => {
        const store = createChatStore();
        const onFatalRenderError = vi.fn((message: string) => {
            expect(message).toBe('native scrollbox failed');
            store.closeEventQueue();
        });
        const preventDefault = vi.fn();
        let recoveryExhausted = false;
        const handle = createFatalRenderEscapeHandler({
            recoveryExhausted: () => recoveryExhausted,
            message: 'native scrollbox failed',
            onFatalRenderError,
        });
        const pending = store.waitForEvent();
        recoveryExhausted = true;

        handle({ ctrl: true, name: 'c', preventDefault });
        handle({ ctrl: true, name: 'c', preventDefault });

        await expect(pending).resolves.toEqual({ type: 'interrupt' });
        expect(onFatalRenderError).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it('leaves Ctrl+C to normal recovery while the circuit remains closed', () => {
        const onFatalRenderError = vi.fn();
        const preventDefault = vi.fn();
        const handle = createFatalRenderEscapeHandler({
            recoveryExhausted: () => false,
            message: 'render failed',
            onFatalRenderError,
        });

        handle({ ctrl: true, name: 'c', preventDefault });

        expect(onFatalRenderError).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
    });
});
