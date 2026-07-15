/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { AbgOverlayController } from '../../state/abg-overlay-controller';
import type { ChatAppActions } from '../../state/chat-app-actions';
import type { ChatStore } from '../../state/chat-store';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import type { MissionControlServicesLike } from '../../state/mission-services-types';
import type { WelcomeData } from '../../state/welcome-data-types';
import { createRequiredContext } from './context-base';

export type TuiChatSessionValue = {
    readonly store: ChatStore;
    readonly welcomeData?: WelcomeData;
    readonly abgOverlayController?: AbgOverlayController;
    readonly missionControlServices?: MissionControlServicesLike;
    readonly actions?: ChatAppActions;
};

export type MissionControlChatSessionProviderProps = {
    readonly chatStore: ChatStore;
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly children: JSX.Element;
};

const TuiChatSessionContext = createRequiredContext<TuiChatSessionValue>('TuiChatSession');

export function useChatSession(): TuiChatSessionValue {
    return TuiChatSessionContext.useValue();
}

export function useChatAppActions(): ChatAppActions | undefined {
    return useChatSession().actions;
}

export function useAbgOverlayController(): AbgOverlayController | undefined {
    return useChatSession().abgOverlayController;
}

export function useWelcomeData(): WelcomeData | undefined {
    return useChatSession().welcomeData;
}

export function useMissionControlServices(): MissionControlServicesLike | undefined {
    return useChatSession().missionControlServices;
}

export function MissionControlChatSessionProvider(props: MissionControlChatSessionProviderProps): JSX.Element {
    const value = createTuiChatSessionValue(props.chatStore, props.runtimeOptions);
    return <TuiChatSessionContext.Provider value={value}>{props.children}</TuiChatSessionContext.Provider>;
}

/**
 * Optional gate used by the composition root: mounts the chat-session provider
 * only when an interactive `chatStore` is present so non-chat provider unit
 * tests keep working without a session layer.
 */
export function MissionControlChatSessionGate(props: {
    readonly chatStore?: ChatStore;
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly children: JSX.Element;
}): JSX.Element {
    const store = props.chatStore;
    if (store === undefined) {
        return props.children;
    }
    return (
        <MissionControlChatSessionProvider chatStore={store} runtimeOptions={props.runtimeOptions}>
            {props.children}
        </MissionControlChatSessionProvider>
    );
}

function createTuiChatSessionValue(store: ChatStore, options: ChatTuiRuntimeOptions): TuiChatSessionValue {
    return Object.freeze({
        store,
        ...(options.welcomeData !== undefined ? { welcomeData: options.welcomeData } : {}),
        ...(options.abgOverlayController !== undefined ? { abgOverlayController: options.abgOverlayController } : {}),
        ...(options.missionControlServices !== undefined
            ? { missionControlServices: options.missionControlServices }
            : {}),
        ...(options.actions !== undefined ? { actions: options.actions } : {}),
    });
}
