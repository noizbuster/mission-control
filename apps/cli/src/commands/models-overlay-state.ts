/**
 * Pure state reducer and view helper for the two-column models overlay.
 *
 * The left column lists assignable models ({@linkcode ModelProviderSelection});
 * the right column lists the ten built-in roles ({@linkcode ModelsOverlayRoleRow}),
 * each showing its persisted assignment or the default-inherited fallback.
 *
 * Every exported function is side-effect-free: factories build initial state,
 * reducers return a new state object (never mutating the input), and
 * {@linkcode createModelsOverlayView} windows both columns to fit terminal
 * dimensions. Persistence (auth store) and rendering (opentui) are the
 * consumer's job.
 *
 * Provider tabs and search filtering (mirroring oh-my-pi's model-selector
 * concepts, NOT vendored code) narrow the left column: the active tab filters
 * by provider, the search query filters by substring match against
 * `provider/model[#variant]`, and the two compose with AND logic.
 */

import { MODEL_ROLE_IDS, type ModelProviderSelection, type ModelRole } from '@mission-control/protocol';

/** A role row in the right column. `assignment` is the persisted selection if any. */
export type ModelsOverlayRoleRow = {
    readonly role: ModelRole;
    readonly assignment: ModelProviderSelection | undefined;
    /** The default/session model shown when `assignment` is undefined. */
    readonly fallback: ModelProviderSelection;
};

/** A provider tab in the left-column filter bar. */
export type ProviderTab = {
    /** `'all'` for the first tab, or a raw `providerID` for provider tabs. */
    readonly id: string;
    /** `'ALL'` or the formatted label (e.g. `'ANTHROPIC'`, `'ZAI CODING PLAN'`). */
    readonly label: string;
};

/** The full state of the overlay. Pure data; reducers return a new copy. */
export type ModelsOverlayState = {
    readonly leftEntries: readonly ModelProviderSelection[];
    readonly roleRows: readonly ModelsOverlayRoleRow[];
    readonly activeLeftIndex: number;
    readonly activeRightIndex: number;
    readonly focusedColumn: 'left' | 'right';
    readonly searchQuery: string;
    /** `'all'` or a providerID from `leftEntries`. */
    readonly activeProviderTab: string;
};

/** A windowed view computed from state + terminal dimensions. Pure. */
export type ModelsOverlayView = {
    readonly leftVisible: readonly ModelProviderSelection[];
    readonly rightVisible: readonly ModelsOverlayRoleRow[];
    readonly activeLeftIndex: number;
    readonly activeRightIndex: number;
    readonly startIndexLeft: number;
    readonly endIndexLeft: number;
    readonly startIndexRight: number;
    readonly endIndexRight: number;
    readonly focusedColumn: 'left' | 'right';
    /** Filtered count (reflects the active tab + search query). */
    readonly totalLeft: number;
    readonly totalRight: number;
    readonly providerTabs: readonly ProviderTab[];
    readonly activeProviderTab: string;
    readonly searchQuery: string;
    readonly filteredLeftCount: number;
};

/** Options for seeding initial overlay state. */
export type CreateModelsOverlayStateOptions = {
    readonly searchQuery?: string;
    readonly activeProviderTab?: string;
};

/**
 * Build the initial overlay state. Both columns are populated from the inputs,
 * indices start at 0, and the left column is focused first. The optional
 * `searchQuery` and `activeProviderTab` default to `''` and `'all'`.
 */
export function createModelsOverlayState(
    leftEntries: readonly ModelProviderSelection[],
    roleRows: readonly ModelsOverlayRoleRow[],
    options?: CreateModelsOverlayStateOptions,
): ModelsOverlayState {
    return {
        leftEntries,
        roleRows,
        activeLeftIndex: 0,
        activeRightIndex: 0,
        focusedColumn: 'left',
        searchQuery: options?.searchQuery ?? '',
        activeProviderTab: options?.activeProviderTab ?? 'all',
    };
}

/**
 * Build the ten role rows from persisted assignments plus a fallback model.
 * Roles appear in the exact {@linkcode MODEL_ROLE_IDS} order. Roles with an
 * assigned selection carry it; unassigned roles carry `undefined` and inherit
 * the fallback at display time via {@linkcode formatRoleFallback}.
 */
export function createModelsOverlayRoleRows(
    assignments: Partial<Record<ModelRole, ModelProviderSelection>>,
    fallback: ModelProviderSelection,
): readonly ModelsOverlayRoleRow[] {
    return MODEL_ROLE_IDS.map((role) => ({
        role,
        assignment: assignments[role],
        fallback,
    }));
}

/**
 * Format the human-readable fallback string for an unassigned role. Non-default
 * roles show `Using default (<provider>/<model[#variant]>)`; the `default` role
 * shows `Using built-in/session default (<provider>/<model[#variant]>)`.
 */
export function formatRoleFallback(row: ModelsOverlayRoleRow): string {
    const modelPart = formatModelSelection(row.fallback);
    const prefix = row.role === 'default' ? 'Using built-in/session default' : 'Using default';
    return `${prefix} (${modelPart})`;
}

/**
 * Format a selection as `provider/model` or `provider/model#variant`.
 * Shared by {@linkcode formatRoleFallback} and the search filter so both
 * match the same string the component renders.
 */
export function formatModelSelection(selection: ModelProviderSelection): string {
    return selection.variantID !== undefined
        ? `${selection.providerID}/${selection.modelID}#${selection.variantID}`
        : `${selection.providerID}/${selection.modelID}`;
}

/**
 * Format a provider tab label: `providerID.replace(/[-_]+/g, ' ').toUpperCase()`.
 * Mirrors oh-my-pi's `formatProviderTabLabel` concept (not vendored).
 */
export function formatProviderTabLabel(providerID: string): string {
    return providerID.replace(/[-_]+/g, ' ').toUpperCase();
}

/**
 * Compute the provider tabs from the left entries. The first tab is always
 * `ALL`; remaining tabs are one per unique `providerID` in `leftEntries`,
 * sorted alphabetically, labeled via {@linkcode formatProviderTabLabel}.
 */
export function computeProviderTabs(leftEntries: readonly ModelProviderSelection[]): readonly ProviderTab[] {
    const seen = new Set<string>();
    for (const entry of leftEntries) {
        seen.add(entry.providerID);
    }
    const providerIDs = [...seen].sort((a, b) => a.localeCompare(b));
    const tabs: ProviderTab[] = [{ id: 'all', label: 'ALL' }];
    for (const id of providerIDs) {
        tabs.push({ id, label: formatProviderTabLabel(id) });
    }
    return tabs;
}

/**
 * Filter the left entries by the active provider tab AND the search query.
 *
 * Tab: when `activeProviderTab !== 'all'`, only entries whose `providerID`
 * matches pass.
 *
 * Search: when `searchQuery` is non-empty, only entries whose
 * {@linkcode formatModelSelection} string contains the query (case-insensitive
 * substring) pass. Simple `toLowerCase().includes()` normalization is used
 * because model strings are simple (`provider/model[#variant]`) and the
 * allowed search-input chars (`[a-zA-Z0-9/_.-#]`) are all lowercase-stable.
 */
export function filterLeftEntries(
    leftEntries: readonly ModelProviderSelection[],
    activeProviderTab: string,
    searchQuery: string,
): readonly ModelProviderSelection[] {
    let filtered = leftEntries;
    if (activeProviderTab !== 'all') {
        filtered = filtered.filter((entry) => entry.providerID === activeProviderTab);
    }
    const query = searchQuery.toLowerCase();
    if (query.length > 0) {
        filtered = filtered.filter((entry) => formatModelSelection(entry).toLowerCase().includes(query));
    }
    return filtered;
}

/**
 * Window both columns to fit `maxVisible` rows around the active index.
 * The left column operates on the FILTERED list (active tab + search query).
 * `startIndex`/`endIndex` are clamped to bounds; `endIndex` is inclusive.
 * Mirrors the windowing math of `createAgentsDashboardView`.
 */
export function createModelsOverlayView(state: ModelsOverlayState, maxVisible: number): ModelsOverlayView {
    const visibleLimit = Math.max(1, maxVisible);
    const filteredLeft = filterLeftEntries(state.leftEntries, state.activeProviderTab, state.searchQuery);
    const left = computeWindow(state.activeLeftIndex, filteredLeft.length, visibleLimit);
    const right = computeWindow(state.activeRightIndex, state.roleRows.length, visibleLimit);
    const providerTabs = computeProviderTabs(state.leftEntries);
    return {
        leftVisible: filteredLeft.slice(left.startIndex, left.endIndex + 1),
        rightVisible: state.roleRows.slice(right.startIndex, right.endIndex + 1),
        activeLeftIndex: left.clampedIndex,
        activeRightIndex: right.clampedIndex,
        startIndexLeft: left.startIndex,
        endIndexLeft: left.endIndex,
        startIndexRight: right.startIndex,
        endIndexRight: right.endIndex,
        focusedColumn: state.focusedColumn,
        totalLeft: filteredLeft.length,
        totalRight: state.roleRows.length,
        providerTabs,
        activeProviderTab: state.activeProviderTab,
        searchQuery: state.searchQuery,
        filteredLeftCount: filteredLeft.length,
    };
}

/** Move the selection up within the focused column (clamps at the top). */
export function navigateModelsOverlayUp(state: ModelsOverlayState): ModelsOverlayState {
    return navigateWithinColumn(state, -1);
}

/** Move the selection down within the focused column (clamps at the bottom). */
export function navigateModelsOverlayDown(state: ModelsOverlayState): ModelsOverlayState {
    return navigateWithinColumn(state, 1);
}

/** Toggle the focused column between left and right (Tab). Indices are preserved. */
export function switchModelsOverlayColumn(state: ModelsOverlayState): ModelsOverlayState {
    return {
        ...state,
        focusedColumn: state.focusedColumn === 'left' ? 'right' : 'left',
    };
}

/**
 * Assign the focused left model to the focused right role (Enter). Returns a
 * new state with the target role's `assignment` updated. The model is resolved
 * from the FILTERED left list (active tab + search query). Does NOT touch the
 * auth store; persistence is the ChatStore method's job. Returns the input
 * unchanged when the filtered left column is empty or the right index is out
 * of bounds.
 */
export function assignSelectedRole(state: ModelsOverlayState): ModelsOverlayState {
    const filtered = filterLeftEntries(state.leftEntries, state.activeProviderTab, state.searchQuery);
    const model = filtered[state.activeLeftIndex];
    if (model === undefined) return state;
    if (state.roleRows[state.activeRightIndex] === undefined) return state;
    const targetIndex = state.activeRightIndex;
    return {
        ...state,
        roleRows: state.roleRows.map((row, index) => (index === targetIndex ? { ...row, assignment: model } : row)),
    };
}

/**
 * Clear the focused right role to default-inherited (Backspace/Delete when the
 * search query is empty). Returns a new state with the target role's
 * `assignment` set to `undefined`. Returns the input unchanged when the right
 * index is out of bounds.
 */
export function clearSelectedRole(state: ModelsOverlayState): ModelsOverlayState {
    if (state.roleRows[state.activeRightIndex] === undefined) return state;
    const targetIndex = state.activeRightIndex;
    return {
        ...state,
        roleRows: state.roleRows.map((row, index) => (index === targetIndex ? { ...row, assignment: undefined } : row)),
    };
}

/** Set the search query and reset `activeLeftIndex` to 0. Pure. */
export function setModelsOverlaySearchQuery(state: ModelsOverlayState, query: string): ModelsOverlayState {
    return { ...state, searchQuery: query, activeLeftIndex: 0 };
}

/** Set the active provider tab and reset `activeLeftIndex` to 0. Pure. */
export function setModelsOverlayProviderTab(state: ModelsOverlayState, tabId: string): ModelsOverlayState {
    return { ...state, activeProviderTab: tabId, activeLeftIndex: 0 };
}

type WindowSlice = {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly clampedIndex: number;
};

/** Compute the visible window and clamped active index for a single column. */
function computeWindow(activeIndex: number, total: number, visibleLimit: number): WindowSlice {
    const clampedIndex = total <= 0 ? 0 : Math.min(Math.max(activeIndex, 0), total - 1);
    const startIndex =
        total <= visibleLimit
            ? 0
            : Math.min(Math.max(clampedIndex - Math.floor(visibleLimit / 2), 0), total - visibleLimit);
    const visibleCount = Math.min(visibleLimit, total);
    const endIndex = total === 0 ? 0 : startIndex + visibleCount - 1;
    return { startIndex, endIndex, clampedIndex };
}

/**
 * Move the selection by `delta` within the focused column, clamped to bounds.
 * The left column clamps against the FILTERED count (active tab + search query)
 * so navigation never runs past the visible list.
 */
function navigateWithinColumn(state: ModelsOverlayState, delta: number): ModelsOverlayState {
    if (state.focusedColumn === 'left') {
        const count = filterLeftEntries(state.leftEntries, state.activeProviderTab, state.searchQuery).length;
        if (count === 0) return state;
        const next = Math.min(Math.max(state.activeLeftIndex + delta, 0), count - 1);
        if (next === state.activeLeftIndex) return state;
        return { ...state, activeLeftIndex: next };
    }
    const count = state.roleRows.length;
    if (count === 0) return state;
    const next = Math.min(Math.max(state.activeRightIndex + delta, 0), count - 1);
    if (next === state.activeRightIndex) return state;
    return { ...state, activeRightIndex: next };
}
