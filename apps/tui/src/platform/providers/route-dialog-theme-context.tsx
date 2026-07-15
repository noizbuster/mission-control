/** @jsxImportSource @opentui/solid */

import { TuiStores } from '@mission-control/core';
import { type TuiThemePreference, TuiThemePreferenceSchema } from '@mission-control/protocol';
import { type Accessor, createMemo, createSignal, type JSX, onCleanup, onMount } from 'solid-js';
import { darkTheme, noColorTheme } from '../../components/markdown/interactive-theme.js';
import type { TerminalMarkdownTheme } from '../../components/markdown/theme.js';
import {
    ACCENTS,
    APPROVAL_LEVEL_COLORS,
    LEFT_ACCENT_BORDER,
    OVERLAY_PANEL_BG,
    QUESTION_CURSOR,
    QUESTION_CURSOR_FG,
    QUESTION_SELECTED_FG,
    SELECTED_BG,
    STATUS_LINE_BG,
} from '../../components/overlay-theme.js';
import { useModeStack } from '../keymap/mode-stack.js';
import { createRequiredContext } from './context-base.js';
import { useTuiRuntime } from './runtime-context.js';

export type TuiRouteKind = 'chat' | 'session' | 'plugin' | 'dialog' | 'system';

export type TuiRouteLabel = {
    readonly id: string;
    readonly label: string;
    readonly kind: TuiRouteKind;
};

export type TuiRouteService = {
    readonly current: Accessor<TuiRouteLabel>;
    readonly history: Accessor<readonly TuiRouteLabel[]>;
    readonly setRoute: (route: TuiRouteLabel) => void;
    readonly resetRoute: () => void;
};

export type TuiDialogDescriptor = {
    readonly title: string;
    readonly body: string;
};

export type TuiDialogState = TuiDialogDescriptor & {
    readonly id: number;
};

export type TuiDialogCancelSource = 'escape' | 'ctrl-c' | 'programmatic';

export type TuiDialogCancelResult = {
    readonly kind: 'closed' | 'already-closed';
    readonly source: TuiDialogCancelSource;
};

export type TuiDialogService = {
    readonly current: Accessor<TuiDialogState | null>;
    readonly open: (dialog: TuiDialogDescriptor) => () => void;
    readonly close: () => void;
    readonly cancel: (source: TuiDialogCancelSource) => TuiDialogCancelResult;
};

export type TuiOverlayAccents = {
    readonly default: string;
    readonly approval: string;
    readonly question: string;
    readonly error: string;
};

export type TuiOverlayTheme = {
    readonly selectedBg: string;
    readonly panelBg: string;
    readonly questionSelectedFg: string;
    readonly questionCursorFg: string;
    readonly questionCursor: string;
    readonly leftAccentBorder: typeof LEFT_ACCENT_BORDER;
    readonly statusLineBg: string;
    readonly approvalLevelColors: typeof APPROVAL_LEVEL_COLORS;
    readonly accents: TuiOverlayAccents;
};

export type TuiThemeSaveResult = { readonly kind: 'saved' } | { readonly kind: 'invalid-preference' };

export type TuiThemePreferenceStoreLike = {
    readonly getPreference: () => Promise<TuiThemePreference>;
    readonly savePreference: (preference: TuiThemePreference) => Promise<void>;
};

export type TuiThemeService = {
    readonly preference: Accessor<TuiThemePreference>;
    readonly overlayTheme: Accessor<TuiOverlayTheme>;
    readonly markdownTheme: Accessor<TerminalMarkdownTheme>;
    readonly savePreference: (preference: TuiThemePreference) => Promise<TuiThemeSaveResult>;
    readonly savePreferenceFromUnknown: (value: unknown) => Promise<TuiThemeSaveResult>;
};

export type MissionControlRouteThemeProvidersProps = {
    readonly themePreferenceStore?: TuiThemePreferenceStoreLike;
    readonly children: JSX.Element;
};

export type MissionControlDialogProviderProps = {
    readonly children: JSX.Element;
};

const TuiRouteContext = createRequiredContext<TuiRouteService>('TuiRoute');
const TuiDialogContext = createRequiredContext<TuiDialogService>('TuiDialog');
const TuiThemeContext = createRequiredContext<TuiThemeService>('TuiTheme');

export function useTuiRoute(): TuiRouteService {
    return TuiRouteContext.useValue();
}

export function useTuiDialog(): TuiDialogService {
    return TuiDialogContext.useValue();
}

export function useTuiTheme(): TuiThemeService {
    return TuiThemeContext.useValue();
}

export function MissionControlRouteThemeProviders(props: MissionControlRouteThemeProvidersProps): JSX.Element {
    const runtime = useTuiRuntime();
    const initialRoute = createInitialRoute(runtime.sessionID);
    const route = createTuiRouteService(initialRoute);
    const theme = createTuiThemeService(
        props.themePreferenceStore ?? new TuiStores.TuiThemePreferenceStore(),
        TuiStores.defaultTuiThemePreference(),
    );

    return (
        <TuiRouteContext.Provider value={route}>
            <TuiThemeContext.Provider value={theme}>{props.children}</TuiThemeContext.Provider>
        </TuiRouteContext.Provider>
    );
}

export function MissionControlDialogProvider(props: MissionControlDialogProviderProps): JSX.Element {
    const dialog = createTuiDialogService();
    return <TuiDialogContext.Provider value={dialog}>{props.children}</TuiDialogContext.Provider>;
}

function createInitialRoute(sessionID: string | undefined): TuiRouteLabel {
    const suffix = sessionID ?? 'new';
    return Object.freeze({ id: 'chat', label: `Session ${suffix}`, kind: 'chat' });
}

function createTuiRouteService(initialRoute: TuiRouteLabel): TuiRouteService {
    const [current, setCurrent] = createSignal<TuiRouteLabel>(initialRoute);
    const [history, setHistory] = createSignal<readonly TuiRouteLabel[]>([initialRoute]);

    function setRoute(route: TuiRouteLabel): void {
        const next = Object.freeze(route);
        setCurrent(next);
        setHistory((previous) => [...previous, next]);
    }

    function resetRoute(): void {
        setCurrent(initialRoute);
        setHistory([initialRoute]);
    }

    return Object.freeze({ current, history, setRoute, resetRoute });
}

function createTuiDialogService(): TuiDialogService {
    const modeStack = useModeStack();
    const [current, setCurrent] = createSignal<TuiDialogState | null>(null);
    let nextDialogId = 0;
    let dialogModeActive = false;

    function pushDialogMode(): void {
        if (dialogModeActive) return;
        dialogModeActive = true;
        modeStack.push('dialog');
    }

    function popDialogMode(): void {
        if (!dialogModeActive) return;
        dialogModeActive = false;
        modeStack.pop();
    }

    function open(dialog: TuiDialogDescriptor): () => void {
        nextDialogId += 1;
        const id = nextDialogId;
        setCurrent(Object.freeze({ id, title: dialog.title, body: dialog.body }));
        pushDialogMode();
        return () => {
            if (current()?.id !== id) return;
            setCurrent(null);
            popDialogMode();
        };
    }

    function close(): void {
        if (current() === null) return;
        setCurrent(null);
        popDialogMode();
    }

    function cancel(source: TuiDialogCancelSource): TuiDialogCancelResult {
        if (current() === null) {
            return { kind: 'already-closed', source };
        }
        close();
        return { kind: 'closed', source };
    }

    onCleanup(() => {
        setCurrent(null);
        popDialogMode();
    });

    return Object.freeze({ current, open, close, cancel });
}

function createTuiThemeService(
    store: TuiThemePreferenceStoreLike,
    defaultPreference: TuiThemePreference,
): TuiThemeService {
    const [preference, setPreference] = createSignal<TuiThemePreference>(defaultPreference);
    const overlayTheme = createMemo(() => createOverlayTheme(preference()));
    const markdownTheme = createMemo(() => (preference().activeThemeId === 'no-color' ? noColorTheme : darkTheme));
    let disposed = false;

    onMount(() => {
        void store.getPreference().then((storedPreference) => {
            if (disposed) return;
            setPreference(storedPreference);
        });
    });

    onCleanup(() => {
        disposed = true;
    });

    async function savePreference(preferenceValue: TuiThemePreference): Promise<TuiThemeSaveResult> {
        const result = TuiThemePreferenceSchema.safeParse(preferenceValue);
        if (!result.success) {
            return { kind: 'invalid-preference' };
        }
        await store.savePreference(result.data);
        setPreference(result.data);
        return { kind: 'saved' };
    }

    async function savePreferenceFromUnknown(value: unknown): Promise<TuiThemeSaveResult> {
        const result = TuiThemePreferenceSchema.safeParse(value);
        if (!result.success) {
            return { kind: 'invalid-preference' };
        }
        return savePreference(result.data);
    }

    return Object.freeze({ preference, overlayTheme, markdownTheme, savePreference, savePreferenceFromUnknown });
}

function createOverlayTheme(preference: TuiThemePreference): TuiOverlayTheme {
    const defaultAccent = overrideValue(preference, 'overlay.accent.default');
    const approvalAccent = overrideValue(preference, 'overlay.accent.approval');
    const questionAccent = overrideValue(preference, 'overlay.accent.question');
    const errorAccent = overrideValue(preference, 'overlay.accent.error');
    return Object.freeze({
        selectedBg: overrideValue(preference, 'overlay.selectedBg') ?? SELECTED_BG,
        panelBg: overrideValue(preference, 'overlay.panelBg') ?? OVERLAY_PANEL_BG,
        questionSelectedFg: overrideValue(preference, 'overlay.questionSelectedFg') ?? QUESTION_SELECTED_FG,
        questionCursorFg: overrideValue(preference, 'overlay.questionCursorFg') ?? QUESTION_CURSOR_FG,
        questionCursor: overrideValue(preference, 'overlay.questionCursor') ?? QUESTION_CURSOR,
        leftAccentBorder: LEFT_ACCENT_BORDER,
        statusLineBg: overrideValue(preference, 'overlay.statusLineBg') ?? STATUS_LINE_BG,
        approvalLevelColors: APPROVAL_LEVEL_COLORS,
        accents: Object.freeze({
            default: defaultAccent ?? ACCENTS.default,
            approval: approvalAccent ?? ACCENTS.approval,
            question: questionAccent ?? ACCENTS.question,
            error: errorAccent ?? ACCENTS.error,
        }),
    });
}

function overrideValue(preference: TuiThemePreference, key: string): string | undefined {
    return preference.customOverrides.find((override) => override.key === key)?.value;
}
