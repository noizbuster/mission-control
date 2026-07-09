/** @jsxImportSource @opentui/solid */

import { createContext, type JSX, onCleanup, useContext } from 'solid-js';

export class MissingTuiProviderError extends Error {
    readonly providerName: string;

    constructor(providerName: string) {
        super(`Missing TUI provider "${providerName}". Mount MissionControlTuiProviders above this hook.`);
        this.name = 'MissingTuiProviderError';
        this.providerName = providerName;
    }
}

export type RequiredContext<TValue> = {
    readonly Provider: (props: RequiredContextProviderProps<TValue>) => JSX.Element;
    readonly useValue: () => TValue;
};

export type RequiredContextProviderProps<TValue> = {
    readonly value: TValue;
    readonly children: JSX.Element;
};

export function createRequiredContext<TValue>(providerName: string): RequiredContext<TValue> {
    const context = createContext<TValue>();

    function Provider(props: RequiredContextProviderProps<TValue>): JSX.Element {
        return context.Provider({
            value: props.value,
            get children(): JSX.Element {
                return props.children;
            },
        });
    }

    function useValue(): TValue {
        const value = useContext(context);
        if (value === undefined) {
            throw new MissingTuiProviderError(providerName);
        }
        return value;
    }

    return { Provider, useValue };
}

export type TuiProviderLifecycle = {
    readonly registerCleanup: (cleanup: () => void) => void;
};

const TuiProviderLifecycleContext = createRequiredContext<TuiProviderLifecycle>('TuiProviderLifecycle');

export function useTuiProviderLifecycle(): TuiProviderLifecycle {
    return TuiProviderLifecycleContext.useValue();
}

export function TuiProviderLifecycleScope(props: { readonly children: JSX.Element }): JSX.Element {
    const cleanups: (() => void)[] = [];
    const lifecycle: TuiProviderLifecycle = {
        registerCleanup: (cleanup) => {
            cleanups.push(cleanup);
        },
    };

    onCleanup(() => {
        for (const cleanup of cleanups.splice(0).reverse()) {
            cleanup();
        }
    });

    return TuiProviderLifecycleContext.Provider({
        value: lifecycle,
        get children(): JSX.Element {
            return props.children;
        },
    });
}
