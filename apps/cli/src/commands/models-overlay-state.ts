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
 * consumer's job — TODO #6 bridges this contract to the ChatStore slice and
 * the `ModelsOverlay` component. Mirrors the `createAgentsDashboardView` +
 * agents-dashboard navigation precedent in `chat-store.ts`.
 */

import { MODEL_ROLE_IDS, type ModelProviderSelection, type ModelRole } from '@mission-control/protocol';

/** A role row in the right column. `assignment` is the persisted selection if any. */
export type ModelsOverlayRoleRow = {
    readonly role: ModelRole;
    readonly assignment: ModelProviderSelection | undefined;
    /** The default/session model shown when `assignment` is undefined. */
    readonly fallback: ModelProviderSelection;
};

/** The full state of the overlay. Pure data; reducers return a new copy. */
export type ModelsOverlayState = {
    readonly leftEntries: readonly ModelProviderSelection[];
    readonly roleRows: readonly ModelsOverlayRoleRow[];
    readonly activeLeftIndex: number;
    readonly activeRightIndex: number;
    readonly focusedColumn: 'left' | 'right';
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
    readonly totalLeft: number;
    readonly totalRight: number;
};

/**
 * Build the initial overlay state. Both columns are populated from the inputs,
 * indices start at 0, and the left column is focused first.
 */
export function createModelsOverlayState(
    leftEntries: readonly ModelProviderSelection[],
    roleRows: readonly ModelsOverlayRoleRow[],
): ModelsOverlayState {
    return {
        leftEntries,
        roleRows,
        activeLeftIndex: 0,
        activeRightIndex: 0,
        focusedColumn: 'left',
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
    const selection = row.fallback;
    const modelPart =
        selection.variantID !== undefined
            ? `${selection.providerID}/${selection.modelID}#${selection.variantID}`
            : `${selection.providerID}/${selection.modelID}`;
    const prefix = row.role === 'default' ? 'Using built-in/session default' : 'Using default';
    return `${prefix} (${modelPart})`;
}

/**
 * Window both columns to fit `maxVisible` rows around the active index.
 * `startIndex`/`endIndex` are clamped to bounds; `endIndex` is inclusive.
 * Mirrors the windowing math of `createAgentsDashboardView`.
 */
export function createModelsOverlayView(state: ModelsOverlayState, maxVisible: number): ModelsOverlayView {
    const visibleLimit = Math.max(1, maxVisible);
    const left = computeWindow(state.activeLeftIndex, state.leftEntries.length, visibleLimit);
    const right = computeWindow(state.activeRightIndex, state.roleRows.length, visibleLimit);
    return {
        leftVisible: state.leftEntries.slice(left.startIndex, left.endIndex + 1),
        rightVisible: state.roleRows.slice(right.startIndex, right.endIndex + 1),
        activeLeftIndex: left.clampedIndex,
        activeRightIndex: right.clampedIndex,
        startIndexLeft: left.startIndex,
        endIndexLeft: left.endIndex,
        startIndexRight: right.startIndex,
        endIndexRight: right.endIndex,
        focusedColumn: state.focusedColumn,
        totalLeft: state.leftEntries.length,
        totalRight: state.roleRows.length,
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
 * new state with the target role's `assignment` updated. Does NOT touch the
 * auth store; persistence is the ChatStore method's job (called by #6). Returns
 * the input unchanged when the left column is empty or the right index is out
 * of bounds.
 */
export function assignSelectedRole(state: ModelsOverlayState): ModelsOverlayState {
    const model = state.leftEntries[state.activeLeftIndex];
    if (model === undefined) return state;
    if (state.roleRows[state.activeRightIndex] === undefined) return state;
    const targetIndex = state.activeRightIndex;
    return {
        ...state,
        roleRows: state.roleRows.map((row, index) => (index === targetIndex ? { ...row, assignment: model } : row)),
    };
}

/**
 * Clear the focused right role to default-inherited (Backspace/Delete). Returns
 * a new state with the target role's `assignment` set to `undefined`. Returns
 * the input unchanged when the right index is out of bounds.
 */
export function clearSelectedRole(state: ModelsOverlayState): ModelsOverlayState {
    if (state.roleRows[state.activeRightIndex] === undefined) return state;
    const targetIndex = state.activeRightIndex;
    return {
        ...state,
        roleRows: state.roleRows.map((row, index) => (index === targetIndex ? { ...row, assignment: undefined } : row)),
    };
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

/** Move the selection by `delta` within the focused column, clamped to bounds. */
function navigateWithinColumn(state: ModelsOverlayState, delta: number): ModelsOverlayState {
    if (state.focusedColumn === 'left') {
        const count = state.leftEntries.length;
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
