import type { TuiPluginSource } from '@mission-control/core';
import type {
    TuiKvEntry,
    TuiPluginCapabilityId,
    TuiPluginCommandDescriptor,
    TuiPluginDiagnostic,
    TuiPluginManifest,
    TuiPluginManifestInput,
    TuiPluginRouteDescriptor,
    TuiPluginSlotDescriptor,
} from '@mission-control/protocol';
import type { Accessor } from 'solid-js';
import type { TuiDialogService, TuiRouteService, TuiThemeService } from './route-dialog-theme-context.js';

export type TuiPluginManifestStoreLike = {
    readonly listManifests: () => Promise<readonly TuiPluginManifest[]>;
    readonly saveManifest: (manifest: TuiPluginManifestInput) => Promise<void>;
    readonly appendDiagnostic: (diagnostic: TuiPluginDiagnostic) => Promise<void>;
};

export type TuiPluginKvStoreLike = {
    readonly getString: (namespace: string, key: string) => Promise<string | undefined>;
    readonly setEntry: (namespace: string, entry: TuiKvEntry) => Promise<void>;
    readonly deleteEntry: (namespace: string, key: string) => Promise<void>;
};

export type TuiPluginCommandHandler = () => void | Promise<void>;

export type TuiPluginRuntimeApi = {
    readonly pluginName: string;
    readonly capabilities: readonly TuiPluginCapabilityId[];
    readonly registerSlot: (descriptor: TuiPluginSlotDescriptor) => void;
    readonly registerRoute: (descriptor: TuiPluginRouteDescriptor) => void;
    readonly registerCommand: (descriptor: TuiPluginCommandDescriptor, handler?: TuiPluginCommandHandler) => void;
    readonly kv: {
        readonly getString: (key: string) => Promise<string | undefined>;
        readonly setString: (key: string, value: string) => Promise<void>;
        readonly delete: (key: string) => Promise<void>;
    };
    readonly dialog: Pick<TuiDialogService, 'open' | 'close' | 'cancel'>;
    readonly route: Pick<TuiRouteService, 'setRoute' | 'resetRoute' | 'current'>;
    readonly theme: Pick<TuiThemeService, 'preference' | 'savePreference'>;
};

export type TuiPluginRuntimeDefinition = {
    readonly source: TuiPluginSource;
    readonly manifest: unknown;
    readonly setup?: (api: TuiPluginRuntimeApi) => void | Promise<void>;
};

export type TuiPluginDispatchResult =
    | { readonly kind: 'handled' }
    | { readonly kind: 'missing' }
    | { readonly kind: 'failed' };

export type TuiPluginRuntimeService = {
    readonly slots: Accessor<readonly TuiPluginSlotDescriptor[]>;
    readonly routes: Accessor<readonly TuiPluginRouteDescriptor[]>;
    readonly commands: Accessor<readonly TuiPluginCommandDescriptor[]>;
    readonly diagnostics: Accessor<readonly TuiPluginDiagnostic[]>;
    readonly ready: Promise<void>;
    readonly dispatchCommand: (commandId: string) => Promise<TuiPluginDispatchResult>;
};
