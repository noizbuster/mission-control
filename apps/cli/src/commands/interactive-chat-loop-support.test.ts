import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    interruptActiveTurnBounded,
    PROCESS_SIGNAL_FORCE_EXIT_MS,
    registerProcessTerminalCleanup,
} from './interactive-interrupt-settlement';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function buildHungTurn(): {
    readonly turn: { interrupt: (mode: 'soft' | 'force') => void; done: Promise<void> };
    readonly interrupts: string[];
} {
    const interrupts: string[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const turn = {
        interrupt: (mode: 'soft' | 'force') => {
            interrupts.push(mode);
            if (mode === 'force') {
                resolveDone?.();
            }
        },
        done,
    };
    return { turn, interrupts };
}

describe('interruptActiveTurnBounded', () => {
    it('force-interrupts when soft settle times out', async () => {
        // Given: a turn that never settles on soft interrupt
        vi.useFakeTimers();
        const { turn, interrupts } = buildHungTurn();

        // When
        const pending = interruptActiveTurnBounded(turn, 50, 50);
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(50);
        await pending;

        // Then
        expect(interrupts).toEqual(['soft', 'force']);
    });
});

describe('registerProcessTerminalCleanup', () => {
    it('hard-exits on the second SIGINT', () => {
        // Given
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const close = vi.fn();
        const unregister = registerProcessTerminalCleanup({ close });

        try {
            // When
            process.emit('SIGINT');
            process.emit('SIGINT');

            // Then
            expect(close).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(130);
            expect(PROCESS_SIGNAL_FORCE_EXIT_MS).toBeGreaterThan(0);
        } finally {
            unregister();
        }
    });

    it('invokes onForceExit synchronously before process.exit on the second signal', () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const close = vi.fn();
        const onForceExit = vi.fn();
        const unregister = registerProcessTerminalCleanup({ close, onForceExit });

        try {
            process.emit('SIGINT');
            process.emit('SIGINT');

            expect(onForceExit).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(130);
            const onForceExitOrder = onForceExit.mock.invocationCallOrder[0];
            const exitOrder = exitSpy.mock.invocationCallOrder[0];
            expect(onForceExitOrder).not.toBeUndefined();
            expect(exitOrder).not.toBeUndefined();
            if (onForceExitOrder !== undefined && exitOrder !== undefined) {
                expect(onForceExitOrder).toBeLessThan(exitOrder);
            }
        } finally {
            unregister();
        }
    });

    it('survives a throwing onForceExit hook and still exits', () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const close = vi.fn();
        const onForceExit = vi.fn(() => {
            throw new Error('hook blew up');
        });
        const unregister = registerProcessTerminalCleanup({ close, onForceExit });

        try {
            process.emit('SIGINT');
            process.emit('SIGINT');

            expect(exitSpy).toHaveBeenCalledWith(130);
        } finally {
            unregister();
        }
    });
});
