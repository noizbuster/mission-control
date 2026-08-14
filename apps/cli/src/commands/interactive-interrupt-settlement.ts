/**
 * Bounded interrupt settlement for interactive chat turns.
 * Kept free of heavy runtime imports so unit tests do not load the full agent graph.
 */

export const INTERRUPT_SETTLE_TIMEOUT_MS = 2_500;
export const FORCE_INTERRUPT_SETTLE_TIMEOUT_MS = 1_000;
export const PROCESS_SIGNAL_FORCE_EXIT_MS = 3_000;

export type InterruptibleTurn = {
    readonly interrupt: (mode: 'soft' | 'force') => void;
    readonly done: Promise<unknown>;
};

export async function stopActiveTurn(activeTurn: InterruptibleTurn | undefined): Promise<undefined> {
    if (activeTurn === undefined) {
        return undefined;
    }
    activeTurn.interrupt('force');
    await settleTurnOrTimeout(activeTurn, FORCE_INTERRUPT_SETTLE_TIMEOUT_MS);
    return undefined;
}

export async function interruptActiveTurnBounded(
    activeTurn: InterruptibleTurn,
    softTimeoutMs: number = INTERRUPT_SETTLE_TIMEOUT_MS,
    forceTimeoutMs: number = FORCE_INTERRUPT_SETTLE_TIMEOUT_MS,
): Promise<void> {
    activeTurn.interrupt('soft');
    const softSettled = await settleTurnOrTimeout(activeTurn, softTimeoutMs);
    if (softSettled) {
        return;
    }
    activeTurn.interrupt('force');
    await settleTurnOrTimeout(activeTurn, forceTimeoutMs);
}

async function settleTurnOrTimeout(activeTurn: InterruptibleTurn, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const winner = await Promise.race([
            activeTurn.done.then(() => 'done' as const),
            new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), timeoutMs);
                timer.unref?.();
            }),
        ]);
        return winner === 'done';
    } finally {
        clearTimeout(timer);
    }
}

export type ProcessCleanupInput = {
    readonly close: () => void;
    /**
     * Optional synchronous callback invoked immediately before `process.exit`
     * on the force-exit path (second signal or force-exit timer). Use it to
     * emit a final status line so the user sees a session-end marker even
     * when the chat loop did not get a chance to exit cleanly.
     */
    readonly onForceExit?: () => void;
};

/**
 * Register SIGINT/SIGTERM/SIGHUP cleanup (omp postmortem signal parity:
 * 130/143/129). First signal closes input and schedules hard exit; second
 * signal exits immediately. Soft keyboard Ctrl+C in raw TUI mode is handled
 * separately as an interrupt event — this path covers out-of-band kill,
 * terminal/window close (SIGHUP), and non-raw terminals. Without the SIGHUP
 * listener the OS default kills the process before any JS cleanup runs, so
 * the debounced prompt draft and terminal restore are lost.
 */
export function registerProcessTerminalCleanup(input: ProcessCleanupInput, onCleanupExtra?: () => void): () => void {
    let cleaned = false;
    let signalCount = 0;
    let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        if (cleaned) {
            return;
        }
        cleaned = true;
        input.close();
        onCleanupExtra?.();
    };
    const exitCodeFor = (signal: NodeJS.Signals): number =>
        signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 130;
    const forceExit = (code: number) => {
        cleanup();
        try {
            input.onForceExit?.();
        } catch {
            // force-exit hook must never prevent process termination
        }
        process.exit(code);
    };
    const onSignal = (signal: NodeJS.Signals) => {
        signalCount += 1;
        cleanup();
        if (signalCount >= 2) {
            forceExit(exitCodeFor(signal));
            return;
        }
        if (forceExitTimer === undefined) {
            forceExitTimer = setTimeout(() => {
                forceExit(exitCodeFor(signal));
            }, PROCESS_SIGNAL_FORCE_EXIT_MS);
            forceExitTimer.unref?.();
        }
    };
    const onExit = () => {
        cleanup();
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.once('exit', onExit);

    return () => {
        clearTimeout(forceExitTimer);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
        process.off('exit', onExit);
    };
}
