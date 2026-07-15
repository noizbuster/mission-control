/** @jsxImportSource @opentui/solid */

import type { TuiPluginCapabilityId } from '@mission-control/protocol';
import type { CliRenderer } from '@opentui/core';
import type { JSX } from 'solid-js';
import type { ChatStore } from '../../state/chat-store';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import type { ClipboardServiceRenderer } from '../clipboard-service';
import { ChatKeymapProvider } from '../keymap/keymap-provider';
import { MissionControlChatSessionGate } from './chat-session-context';
import { MissionControlClipboardToastProviders } from './clipboard-toast-context';
import { TuiProviderLifecycleScope } from './context-base';
import {
    MissionControlLocalPreferencesProvider,
    type TuiLocalPreferencesStoreLike,
} from './local-preferences-context';
import {
    MissionControlPluginRuntimeProvider,
    type TuiPluginKvStoreLike,
    type TuiPluginManifestStoreLike,
    type TuiPluginRuntimeDefinition,
} from './plugin-runtime-context';
import { MissionControlProjectSyncProvider } from './project-sync-context';
import { MissionControlPromptHistoryProvider, type TuiPromptHistoryStoreLike } from './prompt-history-context';
import {
    MissionControlPromptServicesProvider,
    type TuiFrecencyStoreLike,
    type TuiPromptStashStoreLike,
} from './prompt-services-context';
import {
    MissionControlDialogProvider,
    MissionControlRouteThemeProviders,
    type TuiThemePreferenceStoreLike,
} from './route-dialog-theme-context';
import { MissionControlRuntimeProviders, type MissionControlTuiProviderEnvironment } from './runtime-context';
import { MissionControlRuntimeEventsProvider } from './runtime-events-context';

export * from './chat-session-context';
export * from './clipboard-toast-context';
export * from './context-base';
export * from './local-preferences-context';
export * from './plugin-runtime-context';
export * from './project-sync-context';
export * from './prompt-history-context';
export * from './prompt-services-context';
export * from './route-dialog-theme-context';
export * from './runtime-context';
export * from './runtime-events-context';

export type TuiKeymapProviderComponent<TRenderer = CliRenderer> = (props: {
    readonly useRenderer: () => TRenderer;
    readonly children: JSX.Element;
}) => JSX.Element;

export type MissionControlTuiProviderTreeProps<TRenderer extends ClipboardServiceRenderer> = {
    readonly useRenderer: () => TRenderer;
    readonly keymapProvider: TuiKeymapProviderComponent<TRenderer>;
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly environment?: MissionControlTuiProviderEnvironment;
    readonly themePreferenceStore?: TuiThemePreferenceStoreLike;
    readonly localPreferencesStore?: TuiLocalPreferencesStoreLike;
    readonly promptHistoryStore?: TuiPromptHistoryStoreLike;
    readonly promptStashStore?: TuiPromptStashStoreLike;
    readonly frecencyStore?: TuiFrecencyStoreLike;
    readonly pluginManifestStore?: TuiPluginManifestStoreLike;
    readonly pluginKvStore?: TuiPluginKvStoreLike;
    readonly allowedPluginCapabilities?: readonly TuiPluginCapabilityId[];
    readonly plugins?: readonly TuiPluginRuntimeDefinition[];
    readonly chatStore?: ChatStore;
    readonly children: JSX.Element;
};

export function composeMissionControlProviderTree<TRenderer extends ClipboardServiceRenderer>(
    props: MissionControlTuiProviderTreeProps<TRenderer>,
): JSX.Element {
    const KeymapProviderComponent = props.keymapProvider;
    return (
        <TuiProviderLifecycleScope>
            <MissionControlRuntimeProviders
                runtimeOptions={props.runtimeOptions}
                {...(props.environment !== undefined ? { environment: props.environment } : {})}
            >
                <MissionControlChatSessionGate
                    runtimeOptions={props.runtimeOptions}
                    {...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {})}
                >
                    <MissionControlRuntimeEventsProvider runtimeOptions={props.runtimeOptions}>
                        <MissionControlProjectSyncProvider
                            {...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {})}
                        >
                            <MissionControlRouteThemeProviders
                                {...(props.themePreferenceStore !== undefined
                                    ? { themePreferenceStore: props.themePreferenceStore }
                                    : {})}
                            >
                                <MissionControlLocalPreferencesProvider
                                    {...(props.localPreferencesStore !== undefined
                                        ? { localPreferencesStore: props.localPreferencesStore }
                                        : {})}
                                >
                                    <MissionControlPromptHistoryProvider
                                        {...(props.promptHistoryStore !== undefined
                                            ? { promptHistoryStore: props.promptHistoryStore }
                                            : {})}
                                        {...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {})}
                                    >
                                        <MissionControlPromptServicesProvider
                                            {...(props.promptStashStore !== undefined
                                                ? { promptStashStore: props.promptStashStore }
                                                : {})}
                                            {...(props.frecencyStore !== undefined
                                                ? { frecencyStore: props.frecencyStore }
                                                : {})}
                                            {...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {})}
                                        >
                                            <MissionControlClipboardToastProviders useRenderer={props.useRenderer}>
                                                <KeymapProviderComponent useRenderer={props.useRenderer}>
                                                    <MissionControlDialogProvider>
                                                        <MissionControlPluginRuntimeProvider
                                                            {...(props.pluginManifestStore !== undefined
                                                                ? { manifestStore: props.pluginManifestStore }
                                                                : {})}
                                                            {...(props.pluginKvStore !== undefined
                                                                ? { kvStore: props.pluginKvStore }
                                                                : {})}
                                                            {...(props.allowedPluginCapabilities !== undefined
                                                                ? {
                                                                      allowedCapabilities:
                                                                          props.allowedPluginCapabilities,
                                                                  }
                                                                : {})}
                                                            {...(props.plugins !== undefined
                                                                ? { plugins: props.plugins }
                                                                : {})}
                                                        >
                                                            {props.children}
                                                        </MissionControlPluginRuntimeProvider>
                                                    </MissionControlDialogProvider>
                                                </KeymapProviderComponent>
                                            </MissionControlClipboardToastProviders>
                                        </MissionControlPromptServicesProvider>
                                    </MissionControlPromptHistoryProvider>
                                </MissionControlLocalPreferencesProvider>
                            </MissionControlRouteThemeProviders>
                        </MissionControlProjectSyncProvider>
                    </MissionControlRuntimeEventsProvider>
                </MissionControlChatSessionGate>
            </MissionControlRuntimeProviders>
        </TuiProviderLifecycleScope>
    );
}

export type MissionControlTuiProvidersBaseProps = {
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly environment?: MissionControlTuiProviderEnvironment;
    readonly themePreferenceStore?: TuiThemePreferenceStoreLike;
    readonly localPreferencesStore?: TuiLocalPreferencesStoreLike;
    readonly promptHistoryStore?: TuiPromptHistoryStoreLike;
    readonly promptStashStore?: TuiPromptStashStoreLike;
    readonly frecencyStore?: TuiFrecencyStoreLike;
    readonly pluginManifestStore?: TuiPluginManifestStoreLike;
    readonly pluginKvStore?: TuiPluginKvStoreLike;
    readonly allowedPluginCapabilities?: readonly TuiPluginCapabilityId[];
    readonly plugins?: readonly TuiPluginRuntimeDefinition[];
    readonly chatStore?: ChatStore;
    readonly children: JSX.Element;
};

export type MissionControlTuiProvidersProps<TRenderer extends ClipboardServiceRenderer = CliRenderer> =
    MissionControlTuiProvidersBaseProps &
        (
            | { readonly useRenderer: () => CliRenderer }
            | {
                  readonly useRenderer: () => TRenderer;
                  readonly keymapProvider: TuiKeymapProviderComponent<TRenderer>;
              }
        );

export function MissionControlTuiProviders<TRenderer extends ClipboardServiceRenderer = CliRenderer>(
    props: MissionControlTuiProvidersProps<TRenderer>,
): JSX.Element {
    if ('keymapProvider' in props) {
        return composeMissionControlProviderTree({
            useRenderer: props.useRenderer,
            keymapProvider: props.keymapProvider,
            runtimeOptions: props.runtimeOptions,
            ...(props.environment !== undefined ? { environment: props.environment } : {}),
            ...(props.themePreferenceStore !== undefined ? { themePreferenceStore: props.themePreferenceStore } : {}),
            ...(props.localPreferencesStore !== undefined
                ? { localPreferencesStore: props.localPreferencesStore }
                : {}),
            ...(props.promptHistoryStore !== undefined ? { promptHistoryStore: props.promptHistoryStore } : {}),
            ...(props.promptStashStore !== undefined ? { promptStashStore: props.promptStashStore } : {}),
            ...(props.frecencyStore !== undefined ? { frecencyStore: props.frecencyStore } : {}),
            ...(props.pluginManifestStore !== undefined ? { pluginManifestStore: props.pluginManifestStore } : {}),
            ...(props.pluginKvStore !== undefined ? { pluginKvStore: props.pluginKvStore } : {}),
            ...(props.allowedPluginCapabilities !== undefined
                ? { allowedPluginCapabilities: props.allowedPluginCapabilities }
                : {}),
            ...(props.plugins !== undefined ? { plugins: props.plugins } : {}),
            ...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {}),
            get children() {
                return props.children;
            },
        });
    }

    return composeMissionControlProviderTree({
        useRenderer: props.useRenderer,
        keymapProvider: ChatKeymapProvider,
        runtimeOptions: props.runtimeOptions,
        ...(props.environment !== undefined ? { environment: props.environment } : {}),
        ...(props.themePreferenceStore !== undefined ? { themePreferenceStore: props.themePreferenceStore } : {}),
        ...(props.localPreferencesStore !== undefined ? { localPreferencesStore: props.localPreferencesStore } : {}),
        ...(props.promptHistoryStore !== undefined ? { promptHistoryStore: props.promptHistoryStore } : {}),
        ...(props.promptStashStore !== undefined ? { promptStashStore: props.promptStashStore } : {}),
        ...(props.frecencyStore !== undefined ? { frecencyStore: props.frecencyStore } : {}),
        ...(props.pluginManifestStore !== undefined ? { pluginManifestStore: props.pluginManifestStore } : {}),
        ...(props.pluginKvStore !== undefined ? { pluginKvStore: props.pluginKvStore } : {}),
        ...(props.allowedPluginCapabilities !== undefined
            ? { allowedPluginCapabilities: props.allowedPluginCapabilities }
            : {}),
        ...(props.plugins !== undefined ? { plugins: props.plugins } : {}),
        ...(props.chatStore !== undefined ? { chatStore: props.chatStore } : {}),
        get children() {
            return props.children;
        },
    });
}
