/** @jsxImportSource @opentui/solid */
import { useKeyboard } from '@opentui/solid';
import { createSignal, ErrorBoundary, onCleanup, type JSX } from 'solid-js';
import type { SoftRemountController } from '../state/soft-remount';
import { CHAT_BG, CHAT_ERROR, CHAT_TEXT, CHAT_TEXT_MUTED } from './chat-theme';

interface AppShellProps {
    readonly children: JSX.Element;
    readonly softRemount?: SoftRemountController;
    readonly isEventQueueClosed?: () => boolean;
    /** Terminates the imperative input loop after terminal recovery is exhausted. */
    readonly onFatalRenderError?: (message: string) => void;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message.length > 0 ? message : error.name;
    }
    if (typeof error === 'string') {
        const message = error.trim();
        return message.length > 0 ? message : 'unknown';
    }
    return 'unknown';
}

type FatalRenderEscapeKey = {
    readonly ctrl: boolean;
    readonly name: string;
    preventDefault(): void;
};

export function createFatalRenderEscapeHandler(input: {
    readonly recoveryExhausted: () => boolean;
    readonly message: string;
    readonly onFatalRenderError: ((message: string) => void) | undefined;
}): (key: FatalRenderEscapeKey) => void {
    let settled = false;
    return (key) => {
        if (
            !input.recoveryExhausted() ||
            input.onFatalRenderError === undefined ||
            !key.ctrl ||
            key.name !== 'c' ||
            settled
        ) {
            return;
        }
        settled = true;
        key.preventDefault();
        input.onFatalRenderError(input.message);
    };
}

function ErrorFallback(props: {
    readonly error: unknown;
    readonly softRemount: SoftRemountController | undefined;
    readonly recoveryExhausted: () => boolean;
    readonly onFatalRenderError: ((message: string) => void) | undefined;
}): JSX.Element {
    const message = errorMessage(props.error);
    useKeyboard(
        createFatalRenderEscapeHandler({
            recoveryExhausted: props.recoveryExhausted,
            message,
            onFatalRenderError: props.onFatalRenderError,
        }),
    );
    const canRemount = props.softRemount !== undefined && !props.recoveryExhausted();
    return (
        <box flexDirection="column" width="100%" height="100%" backgroundColor={CHAT_BG} paddingLeft={1} paddingTop={1}>
            <text fg={CHAT_ERROR}>TUI render error</text>
            <text fg={CHAT_TEXT}>{message}</text>
            <text fg={CHAT_TEXT_MUTED}>
                {props.recoveryExhausted()
                    ? 'Session state is preserved. Recovery paused after repeated render errors; Ctrl+C exits.'
                    : canRemount
                      ? 'Session state is preserved. The UI will soft-remount automatically; Ctrl+C exits if it stays blank.'
                      : 'Session state is preserved. Exit with Ctrl+C, then restart if the UI stays blank.'}
            </text>
        </box>
    );
}

/** Solid ErrorBoundary shell for the live interactive App tree. */
export function AppShell(props: AppShellProps): JSX.Element {
    const [recoveryExhausted, setRecoveryExhausted] = createSignal(props.softRemount?.isCircuitOpen() === true);
    const unsubscribeRemount = props.softRemount?.subscribe(() => {
        if (props.softRemount?.isCircuitOpen() === true) {
            setRecoveryExhausted(true);
        }
    });
    onCleanup(() => {
        unsubscribeRemount?.();
    });

    return (
        <ErrorBoundary
            fallback={(error, reset) => {
                // Fire-and-forget soft remount so the generation key advances and
                // App remounts with the same ChatStore. reset() alone cannot rebuild
                // a destroyed native scrollbox subtree reliably.
                // CRITICAL: when the thrash circuit is open, requestRemount does not
                // advance generation — calling reset() would re-enter the same broken
                // tree and tight-loop the ErrorBoundary.
                const circuitOpen = recoveryExhausted();
                if (props.softRemount !== undefined && !circuitOpen) {
                    void props.softRemount.requestRemount('render_error', errorMessage(error)).then((request) => {
                        // Drop late resets if the thrash circuit opened mid-await,
                        // the surface tore down, or the remount was coalesced away.
                        if (
                            request.advanced &&
                            props.softRemount?.isCircuitOpen() !== true &&
                            props.isEventQueueClosed?.() !== true
                        ) {
                            reset();
                        }
                    });
                }
                return (
                    <ErrorFallback
                        error={error}
                        softRemount={props.softRemount}
                        recoveryExhausted={recoveryExhausted}
                        onFatalRenderError={props.onFatalRenderError}
                    />
                );
            }}
        >
            {props.children}
        </ErrorBoundary>
    );
}
