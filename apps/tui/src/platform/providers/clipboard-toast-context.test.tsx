import { ClipboardTarget } from '@opentui/core';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import {
    composeMissionControlProviderTree,
    type TuiClipboardService,
    type TuiKeymapProviderComponent,
    type TuiToastService,
    useTuiClipboard,
    useTuiToast,
} from './index';

type TestRenderer = {
    readonly id: string;
    copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean;
    isOsc52Supported(): boolean;
};

type ObservedServices = {
    readonly clipboard: TuiClipboardService;
    readonly toast: TuiToastService;
};

type RenderedServices = ObservedServices & {
    readonly dispose: () => void;
};

const runtimeOptions: ChatTuiRuntimeOptions = {
    providerID: 'openai',
    modelID: 'gpt-5.5',
};

function makeRenderer(
    supported: boolean,
    copyResult = true,
): TestRenderer & {
    readonly calls: Array<[string, ClipboardTarget | undefined]>;
} {
    const calls: Array<[string, ClipboardTarget | undefined]> = [];
    return {
        id: 'renderer',
        calls,
        copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean {
            calls.push([text, target]);
            return copyResult;
        },
        isOsc52Supported(): boolean {
            return supported;
        },
    };
}

function renderServices(renderer: TestRenderer): RenderedServices {
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    let observed: ObservedServices | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            clipboard: useTuiClipboard(),
            toast: useTuiToast(),
        };
        return null;
    }

    createRoot((dispose) => {
        disposeRoot = dispose;
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions,
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('service consumer did not render');
    }
    return { ...observed, dispose: disposeRoot };
}

describe('TUI clipboard and toast providers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('delegates clipboard writes to OSC52 and exposes support status', async () => {
        const renderer = makeRenderer(true);
        const services = renderServices(renderer);

        const ok = await services.clipboard.copyToClipboard('selected text');

        expect(ok).toBe(true);
        expect(services.clipboard.isOsc52Supported()).toBe(true);
        expect(renderer.calls).toEqual([['selected text', ClipboardTarget.Clipboard]]);

        services.dispose();
    });

    it('reports unsupported OSC52 through copyWithNotice without touching the copy path', async () => {
        const renderer = makeRenderer(false);
        const services = renderServices(renderer);

        const ok = await services.clipboard.copyWithNotice('selected text');

        expect(ok).toBe(false);
        expect(renderer.calls).toEqual([]);
        expect(services.toast.current()).toMatchObject({
            message: 'Clipboard unavailable in this terminal',
            variant: 'warning',
        });

        services.dispose();
    });

    it('emits a success toast when copyWithNotice completes', async () => {
        const renderer = makeRenderer(true);
        const services = renderServices(renderer);

        const ok = await services.clipboard.copyWithNotice('assistant answer');

        expect(ok).toBe(true);
        expect(renderer.calls).toEqual([['assistant answer', ClipboardTarget.Clipboard]]);
        expect(services.toast.current()).toMatchObject({ message: 'Copied to clipboard', variant: 'info' });

        services.dispose();
    });

    it('keeps one active toast, replaces it on reshow, and auto-dismisses it', () => {
        const renderer = makeRenderer(true);
        const services = renderServices(renderer);

        services.toast.show({ message: 'first', variant: 'info' });
        services.toast.show({ message: 'second', variant: 'success' });
        vi.advanceTimersByTime(4999);

        expect(services.toast.current()).toMatchObject({ message: 'second', variant: 'success' });

        vi.advanceTimersByTime(1);

        expect(services.toast.current()).toBeNull();

        services.dispose();
    });
});
