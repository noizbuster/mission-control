/** @jsxImportSource @opentui/solid */

import { ProjectTrustStore, TuiPluginHostRegistry, TuiStores } from '@mission-control/core';
import type { TuiPluginCapabilityId } from '@mission-control/protocol';
import type { JSX } from 'solid-js';
import { useTuiToast } from './clipboard-toast-context';
import { createRequiredContext } from './context-base';
import { createTuiPluginRuntimeService } from './plugin-runtime-service';
import type {
    TuiPluginKvStoreLike,
    TuiPluginManifestStoreLike,
    TuiPluginRuntimeDefinition,
    TuiPluginRuntimeService,
} from './plugin-runtime-types';
import { useTuiDialog, useTuiRoute, useTuiTheme } from './route-dialog-theme-context';
import { useTuiPaths, useTuiStartup } from './runtime-context';

export type {
    TuiPluginCommandHandler,
    TuiPluginDispatchResult,
    TuiPluginKvStoreLike,
    TuiPluginManifestStoreLike,
    TuiPluginRuntimeApi,
    TuiPluginRuntimeDefinition,
    TuiPluginRuntimeService,
} from './plugin-runtime-types';

export type MissionControlPluginRuntimeProviderProps = {
    readonly manifestStore?: TuiPluginManifestStoreLike;
    readonly kvStore?: TuiPluginKvStoreLike;
    readonly allowedCapabilities?: readonly TuiPluginCapabilityId[];
    readonly plugins?: readonly TuiPluginRuntimeDefinition[];
    readonly children: JSX.Element;
};

const TuiPluginRuntimeContext = createRequiredContext<TuiPluginRuntimeService>('TuiPluginRuntime');

export function useTuiPluginRuntime(): TuiPluginRuntimeService {
    return TuiPluginRuntimeContext.useValue();
}

export function MissionControlPluginRuntimeProvider(props: MissionControlPluginRuntimeProviderProps): JSX.Element {
    const paths = useTuiPaths();
    const startup = useTuiStartup();
    const dialog = useTuiDialog();
    const route = useTuiRoute();
    const theme = useTuiTheme();
    const toast = useTuiToast();
    const manifestStore = props.manifestStore ?? new TuiStores.TuiPluginManifestStore({ dataDir: paths.dataDir });
    const kvStore = props.kvStore ?? new TuiStores.TuiKvStore({ dataDir: paths.dataDir });
    const registry = new TuiPluginHostRegistry({
        workspaceRoot: paths.workspaceRoot,
        allowedCapabilities: props.allowedCapabilities ?? [],
        trustLookup: (workspaceRoot) => new ProjectTrustStore({ dataDir: paths.dataDir }).getDecision(workspaceRoot),
        now: () => startup.startedAtEpochMs,
    });
    const service = createTuiPluginRuntimeService({
        registry,
        manifestStore,
        kvStore,
        dialog,
        route,
        theme,
        toast,
        now: () => startup.startedAtEpochMs,
        plugins: props.plugins ?? [],
    });

    return <TuiPluginRuntimeContext.Provider value={service}>{props.children}</TuiPluginRuntimeContext.Provider>;
}
