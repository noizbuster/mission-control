/** @jsxImportSource @opentui/solid */

import { TuiStores } from '@mission-control/core';
import {
    findModelContextPreference,
    modelContextPreferenceKey,
    stepAutoCompactThreshold,
    stepContextLimit,
    upsertModelContextPreference,
} from '@mission-control/config';
import {
    type ModelContextPreference,
    type ModelProviderSelection,
    type TuiLocalPreferences,
    TuiLocalPreferencesSchema,
    type TuiUiToggle,
    type TuiVariantCyclingHint,
} from '@mission-control/protocol';
import { type Accessor, createSignal, type JSX, onCleanup, onMount } from 'solid-js';
import { formatModelSelection } from '../../state/interactive-chat-model';
import { createRequiredContext } from './context-base';
import { useTuiPaths } from './runtime-context';

export type TuiLocalPreferencesStoreLike = {
    readonly getPreferences: () => Promise<TuiLocalPreferences>;
    readonly savePreferences: (preferences: TuiLocalPreferences) => Promise<void>;
};

export type TuiLocalPreferencesService = {
    readonly preferences: Accessor<TuiLocalPreferences>;
    readonly reload: () => Promise<void>;
    readonly addRecentModel: (selection: ModelProviderSelection) => Promise<void>;
    readonly setFavoriteModel: (selection: ModelProviderSelection, favorite: boolean) => Promise<void>;
    readonly setVariantCyclingHint: (hint: TuiVariantCyclingHint) => Promise<void>;
    readonly pinSession: (sessionID: string) => Promise<void>;
    readonly unpinSession: (sessionID: string) => Promise<void>;
    readonly setUiToggle: (toggle: TuiUiToggle) => Promise<void>;
    readonly stepModelContextLimit: (
        selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
        direction: 1 | -1,
        catalogDefault: number | undefined,
    ) => Promise<ModelContextPreference | undefined>;
    readonly stepModelAutoCompactThreshold: (
        selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
        direction: 1 | -1,
    ) => Promise<ModelContextPreference | undefined>;
};

export type MissionControlLocalPreferencesProviderProps = {
    readonly localPreferencesStore?: TuiLocalPreferencesStoreLike;
    readonly children: JSX.Element;
};

const TuiLocalPreferencesContext = createRequiredContext<TuiLocalPreferencesService>('TuiLocalPreferences');

export function useTuiLocalPreferences(): TuiLocalPreferencesService {
    return TuiLocalPreferencesContext.useValue();
}

export function MissionControlLocalPreferencesProvider(
    props: MissionControlLocalPreferencesProviderProps,
): JSX.Element {
    const paths = useTuiPaths();
    const store = props.localPreferencesStore ?? new TuiStores.TuiLocalPreferencesStore({ dataDir: paths.dataDir });
    const service = createTuiLocalPreferencesService(store, TuiStores.emptyTuiLocalPreferences());

    return <TuiLocalPreferencesContext.Provider value={service}>{props.children}</TuiLocalPreferencesContext.Provider>;
}

function createTuiLocalPreferencesService(
    store: TuiLocalPreferencesStoreLike,
    defaultPreferences: TuiLocalPreferences,
): TuiLocalPreferencesService {
    const [preferences, setPreferences] = createSignal<TuiLocalPreferences>(defaultPreferences);
    let disposed = false;

    onMount(() => {
        void reload();
    });

    onCleanup(() => {
        disposed = true;
    });

    async function reload(): Promise<void> {
        const storedPreferences = await store.getPreferences();
        if (disposed) return;
        setPreferences(TuiLocalPreferencesSchema.parse(storedPreferences));
    }

    async function save(nextPreferences: TuiLocalPreferences): Promise<void> {
        const parsed = TuiLocalPreferencesSchema.parse(nextPreferences);
        await store.savePreferences(parsed);
        if (disposed) return;
        setPreferences(parsed);
    }

    async function addRecentModel(selection: ModelProviderSelection): Promise<void> {
        const modelKey = formatModelSelection(selection);
        const current = preferences();
        await save({
            ...current,
            recentModels: [...current.recentModels.filter((candidate) => candidate !== modelKey), modelKey],
        });
    }

    async function setFavoriteModel(selection: ModelProviderSelection, favorite: boolean): Promise<void> {
        const modelKey = formatModelSelection(selection);
        const current = preferences();
        await save({
            ...current,
            favoriteModels: favorite
                ? [...current.favoriteModels.filter((candidate) => candidate !== modelKey), modelKey]
                : current.favoriteModels.filter((candidate) => candidate !== modelKey),
        });
    }

    async function setVariantCyclingHint(hint: TuiVariantCyclingHint): Promise<void> {
        const current = preferences();
        await save({
            ...current,
            variantCyclingHints: [
                ...current.variantCyclingHints.filter((candidate) => candidate.modelId !== hint.modelId),
                hint,
            ],
        });
    }

    async function pinSession(sessionID: string): Promise<void> {
        const current = preferences();
        await save({
            ...current,
            sessionPins: [...current.sessionPins.filter((candidate) => candidate !== sessionID), sessionID],
        });
    }

    async function unpinSession(sessionID: string): Promise<void> {
        const current = preferences();
        await save({
            ...current,
            sessionPins: current.sessionPins.filter((candidate) => candidate !== sessionID),
        });
    }

    async function setUiToggle(toggle: TuiUiToggle): Promise<void> {
        const current = preferences();
        await save({
            ...current,
            uiToggles: [...current.uiToggles.filter((candidate) => candidate.key !== toggle.key), toggle],
        });
    }

    async function stepModelContextLimit(
        selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
        direction: 1 | -1,
        catalogDefault: number | undefined,
    ): Promise<ModelContextPreference | undefined> {
        const current = preferences();
        const existing = findModelContextPreference(current.modelContextPrefs, selection);
        const nextLimit = stepContextLimit({
            current: existing?.contextLimit ?? catalogDefault,
            catalogDefault,
            direction,
        });
        const next: ModelContextPreference = {
            modelKey: modelContextPreferenceKey(selection),
            contextLimit: nextLimit,
            ...(existing?.autoCompactThreshold !== undefined
                ? { autoCompactThreshold: existing.autoCompactThreshold }
                : {}),
        };
        await save({
            ...current,
            modelContextPrefs: upsertModelContextPreference(current.modelContextPrefs, next),
        });
        return findModelContextPreference(preferences().modelContextPrefs, selection);
    }

    async function stepModelAutoCompactThreshold(
        selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
        direction: 1 | -1,
    ): Promise<ModelContextPreference | undefined> {
        const current = preferences();
        const existing = findModelContextPreference(current.modelContextPrefs, selection);
        const nextThreshold = stepAutoCompactThreshold(existing?.autoCompactThreshold ?? 0, direction);
        const next: ModelContextPreference = {
            modelKey: modelContextPreferenceKey(selection),
            ...(existing?.contextLimit !== undefined ? { contextLimit: existing.contextLimit } : {}),
            ...(nextThreshold > 0 ? { autoCompactThreshold: nextThreshold } : {}),
        };
        await save({
            ...current,
            modelContextPrefs: upsertModelContextPreference(current.modelContextPrefs, next),
        });
        return findModelContextPreference(preferences().modelContextPrefs, selection);
    }

    return Object.freeze({
        preferences,
        reload,
        addRecentModel,
        setFavoriteModel,
        setVariantCyclingHint,
        pinSession,
        unpinSession,
        setUiToggle,
        stepModelContextLimit,
        stepModelAutoCompactThreshold,
    });
}
