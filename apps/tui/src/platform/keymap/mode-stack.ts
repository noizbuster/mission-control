/**
 * Solid mode-stack for the which-key panel (T9).
 *
 * Tracks the active "mode" as a stack of mode names. The base mode is always the
 * implicit floor; overlays can push a mode (for example 'autocomplete' or
 * 'palette') and pop it when they close. The which-key panel reads the current
 * mode accessor to filter which bindings it shows.
 *
 * Pure helpers (`pushMode`/`popMode`/`currentMode`) are exported alongside the
 * Solid context so the stack arithmetic is unit-testable without a renderer.
 */

import { type Accessor, createContext, createMemo, createSignal, type JSX, useContext } from 'solid-js';

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
    readonly current: Accessor<string>;
    /** Push a mode onto the stack; it becomes active until popped. */
    readonly push: (mode: string) => void;
    /** Pop the top mode off the stack (base is the floor). */
    readonly pop: () => void;
}

/** Fallback API used when no provider is mounted (base mode, no-ops). */
const NOOP_API: ModeStackApi = {
    current: () => BASE_MODE,
    push: () => {},
    pop: () => {},
};

export const ModeStackContext = createContext<ModeStackApi>(NOOP_API);

/**
 * Provide a mode stack to descendants. The stack starts empty (base active);
 * `useModeStack().push`/`pop` mutate it immutably through the pure helpers.
 */
export function ModeStackProvider(props: { readonly children: JSX.Element }): JSX.Element {
    const [stack, setStack] = createSignal<ModeStack>([]);
    const current = createMemo(() => currentMode(stack()));
    const api: ModeStackApi = {
        current,
        push: (mode: string) => {
            setStack((prev) => pushMode(prev, mode));
        },
        pop: () => {
            setStack((prev) => popMode(prev));
        },
    };
    return ModeStackContext.Provider({
        value: api,
        get children(): JSX.Element {
            return props.children;
        },
    });
}

/** Read the active mode + push/pop controls from the nearest provider. */
export function useModeStack(): ModeStackApi {
    return useContext(ModeStackContext);
}
