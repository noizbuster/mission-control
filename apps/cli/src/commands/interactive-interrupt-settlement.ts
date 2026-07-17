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
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

export type ProcessCleanupInput = {
    readonly close: () => void;
};

/**
 * Register SIGINT/SIGTERM cleanup. First signal closes input and schedules hard exit; second
 * signal exits immediately. Soft keyboard Ctrl+C in raw TUI mode is handled separately as an
 * interrupt event — this path covers out-of-band kill and non-raw terminals.
 */
export function registerProcessTerminalCleanup(
    input: ProcessCleanupInput,
    onCleanupExtra?: () => void,
): () => void {
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
    const forceExit = (code: number) => {
        cleanup();
        process.exit(code);
    };
    const onSignal = (signal: NodeJS.Signals) => {
        signalCount += 1;
        cleanup();
        if (signalCount >= 2) {
            forceExit(signal === 'SIGTERM' ? 143 : 130);
            return;
        }
        if (forceExitTimer === undefined) {
            forceExitTimer = setTimeout(() => {
                forceExit(signal === 'SIGTERM' ? 143 : 130);
            }, PROCESS_SIGNAL_FORCE_EXIT_MS);
            forceExitTimer.unref?.();
        }
    };
    const onExit = () => {
        cleanup();
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.once('exit', onExit);

    return () => {
        if (forceExitTimer !== undefined) {
            clearTimeout(forceExitTimer);
        }
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('exit', onExit);
    };
}
