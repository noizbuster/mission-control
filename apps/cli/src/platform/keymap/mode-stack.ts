/**
 * React mode-stack for the which-key panel (T9).
 *
 * A React context tracking the active "mode" as a stack of mode names. The
 * base mode is always the implicit floor; overlays can push a mode (e.g.
 * 'autocomplete', 'palette') and pop it when they close. The which-key panel
 * reads the CURRENT mode to filter which bindings it shows.
 *
 * REBUILD (not copy) of opencode's SolidJS `createOpencodeModeStack`
 * (tui/src/keymap.tsx:53-110) as a React context. opencode threads the mode
 * through `keymap.setData` + a layer-field compiler so bindings
 * activate/deactivate by mode; mctrl keeps the mode in React state and
 * filters in the panel's pure projection step, which is simpler and avoids
 * registering a layer-field compiler. ONLY the base mode is active by
 * default. NO vim normal/insert/visual mode logic is implemented (OUT of
 * scope by design).
 *
 * Pure helpers (`pushMode`/`popMode`/`currentMode`) are exported alongside
 * the React context so the stack arithmetic is unit-testable without a
 * renderer (apps/cli has no React test renderer; the pure reducer is the
 * contract). This module imports only `react` (no `@opentui/*`), so it never
 * loads the native FFI backend.
 */

import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/** The default, always-present floor mode. */
export const BASE_MODE = 'base';

/** An immutable mode stack (newest mode last). Empty means base is active. */
export type ModeStack = readonly string[];

/** Return the active (top) mode, or `BASE_MODE` when the stack is empty. */
export function currentMode(stack: ModeStack): string {
    if (stack.length === 0) return BASE_MODE;
    return stack[stack.length - 1] ?? BASE_MODE;
}

/** Return a new stack with `mode` pushed on top (immutable). */
export function pushMode(stack: ModeStack, mode: string): ModeStack {
    return [...stack, mode];
}

/** Return a new stack with the top mode removed (immutable; safe on empty). */
export function popMode(stack: ModeStack): ModeStack {
    if (stack.length === 0) return stack;
    return stack.slice(0, -1);
}

/** The public API a consumer reads from the mode-stack context. */
export interface ModeStackApi {
    /** The currently active mode name. */
    readonly current: string;
    /** Push a mode onto the stack; it becomes active until popped. */
    readonly push: (mode: string) => void;
    /** Pop the top mode off the stack (base is the floor). */
    readonly pop: () => void;
}

/** Fallback API used when no provider is mounted (base mode, no-ops). */
const NOOP_API: ModeStackApi = {
    current: BASE_MODE,
    push: () => {},
    pop: () => {},
};

export const ModeStackContext = createContext<ModeStackApi>(NOOP_API);

/**
 * Provide a mode stack to descendants. The stack starts empty (base active);
 * `useModeStack().push`/`pop` mutate it immutably through the pure helpers.
 */
export function ModeStackProvider({ children }: { readonly children: ReactNode }): ReactNode {
    const [stack, setStack] = useState<ModeStack>([]);
    const push = useCallback((mode: string) => {
        setStack((prev) => pushMode(prev, mode));
    }, []);
    const pop = useCallback(() => {
        setStack((prev) => popMode(prev));
    }, []);
    const current = currentMode(stack);
    const api = useMemo<ModeStackApi>(() => ({ current, push, pop }), [current, push, pop]);
    return createElement(ModeStackContext.Provider, { value: api }, children);
}

/** Read the active mode + push/pop controls from the nearest provider. */
export function useModeStack(): ModeStackApi {
    return useContext(ModeStackContext);
}
