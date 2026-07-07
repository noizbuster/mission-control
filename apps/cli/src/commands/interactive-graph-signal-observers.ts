import type { AbgSignal } from '@mission-control/protocol';

export type InteractiveGraphSignalObserver = (signal: AbgSignal) => void;

export function notifyInteractiveGraphSignalObservers(
    observers: readonly InteractiveGraphSignalObserver[],
    signal: AbgSignal,
): void {
    for (const observer of observers) {
        try {
            observer(signal);
        } catch (error: unknown) {
            if (error instanceof Error) {
                process.stderr.write(`ABG overlay observer failed: ${error.message}\n`);
                continue;
            }
            throw error;
        }
    }
}
