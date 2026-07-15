/** @jsxImportSource @opentui/solid */

import { type Accessor, createSignal, type JSX, onCleanup } from 'solid-js';
import { type ClipboardService, type ClipboardServiceRenderer, createClipboardService } from '../clipboard-service';
import { createRequiredContext } from './context-base';

export type TuiToastVariant = 'info' | 'success' | 'warning' | 'error';

export type TuiToastInput = {
    readonly message: string;
    readonly variant: TuiToastVariant;
    readonly title?: string;
    readonly duration?: number;
};

export type TuiToastMessage = {
    readonly id: number;
    readonly message: string;
    readonly variant: TuiToastVariant;
    readonly title?: string;
    readonly duration: number;
};

export type TuiToastService = {
    readonly current: Accessor<TuiToastMessage | null>;
    readonly show: (input: TuiToastInput) => void;
    readonly clear: () => void;
    readonly error: (error: unknown) => void;
};

export interface TuiClipboardService extends ClipboardService {
    copyWithNotice(text: string): Promise<boolean>;
}

export type MissionControlClipboardToastProvidersProps = {
    readonly useRenderer: () => ClipboardServiceRenderer;
    readonly children: JSX.Element;
};

const defaultToastDurationMs = 5000;
const clipboardUnavailableMessage = 'Clipboard unavailable in this terminal';
const clipboardCopiedMessage = 'Copied to clipboard';
const unknownToastErrorMessage = 'Unknown clipboard error';

const TuiToastContext = createRequiredContext<TuiToastService>('TuiToast');
const TuiClipboardContext = createRequiredContext<TuiClipboardService>('TuiClipboard');

export function useTuiToast(): TuiToastService {
    return TuiToastContext.useValue();
}

export function useTuiClipboard(): TuiClipboardService {
    return TuiClipboardContext.useValue();
}

export function MissionControlClipboardToastProviders(props: MissionControlClipboardToastProvidersProps): JSX.Element {
    const toast = createTuiToastService();
    const clipboard = createTuiClipboardService(props.useRenderer(), toast);

    return (
        <TuiToastContext.Provider value={toast}>
            <TuiClipboardContext.Provider value={clipboard}>{props.children}</TuiClipboardContext.Provider>
        </TuiToastContext.Provider>
    );
}

function createTuiToastService(): TuiToastService {
    const [current, setCurrent] = createSignal<TuiToastMessage | null>(null);
    let nextToastId = 0;
    let dismissTimer: ReturnType<typeof setTimeout> | undefined;

    function clearTimer(): void {
        if (dismissTimer !== undefined) {
            clearTimeout(dismissTimer);
            dismissTimer = undefined;
        }
    }

    function clear(): void {
        clearTimer();
        setCurrent(null);
    }

    function show(input: TuiToastInput): void {
        const duration = input.duration ?? defaultToastDurationMs;
        nextToastId += 1;
        setCurrent(Object.freeze({ id: nextToastId, message: input.message, variant: input.variant, duration, ...input.title !== undefined ? { title: input.title } : {} }));
        clearTimer();
        dismissTimer = setTimeout(clear, duration);
    }

    function error(errorValue: unknown): void {
        const message = errorValue instanceof Error ? errorValue.message : unknownToastErrorMessage;
        show({ message, variant: 'error' });
    }

    onCleanup(clearTimer);

    return Object.freeze({ current, show, clear, error });
}

function createTuiClipboardService(renderer: ClipboardServiceRenderer, toast: TuiToastService): TuiClipboardService {
    const clipboard = createClipboardService(renderer);

    async function copyWithNotice(text: string): Promise<boolean> {
        const ok = await clipboard.copyToClipboard(text);
        toast.show({
            message: ok ? clipboardCopiedMessage : clipboardUnavailableMessage,
            variant: ok ? 'info' : 'warning',
        });
        return ok;
    }

    return Object.freeze({
        copyToClipboard: clipboard.copyToClipboard,
        isOsc52Supported: clipboard.isOsc52Supported,
        copyWithNotice,
    });
}
