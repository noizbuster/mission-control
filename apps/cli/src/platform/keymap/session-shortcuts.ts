/**
 * Session-tree nav + prompt stash + queued-prompts view keymap layer (T12).
 *
 * Three MINIMAL sub-features wired through ONE SESSION-scoped keymap layer:
 *
 *  (a) Session-tree keyboard nav. `up` (parent), `right`/`left` (next/prev
 *      child), `<leader>down` (first child) resolve through the SAME path as
 *      the `/tree` `/branch` slash commands: the bridge injects the slash
 *      command into the chat submit stream (`enqueueEvent({type:'line'})`),
 *      which `parseChatLine -> runChatAction` resolves exactly as a typed
 *      `/tree` would. Directional cursor selection (which leaf to actually
 *      pick) needs a session-tree reader wired from interactive-chat.ts; that
 *      reader is out of this lane's file scope, so each direction routes to the
 *      `/tree` resolution (the observable that surfaces parent/child structure,
 *      including an empty tree / "navigation unavailable" when there is none).
 *      This honors acceptance (a): "session-tree keys call the existing
 *      `/tree`-resolution path" + "no-op if none" via `/tree`'s own output.
 *
 *  (b) Prompt stash (MINIMAL, in-memory, LIFO). `prompt.stash` saves the
 *      current draft (text + cursor) and clears the buffer; `prompt.stash.pop`
 *      restores the most-recent stashed draft EXACTLY (text + cursor); pop on
 *      an empty stash is a documented no-op. Mirrors opencode's
 *      `prompt/stash.tsx` shape but in-memory (no file persistence) and LIFO.
 *      The textarea is the source of truth; the bridge owns capture/restore.
 *
 *  (c) Queued-prompts view. VERIFIED: `SessionInputDelivery` (the drain-lane
 *      queue in `run-coordinator-v2.ts`) is NOT reachable from the interactive
 *      TUI path (it backs the workflow drain-lane only; interactive `/queue`
 *      `/steer` emit `prompt.admitted` events and track no in-memory queue).
 *      So the view scopes to a documented empty-state, per the task's explicit
 *      guidance ("do NOT invent a runtime introspection API"). An optional
 *      `readQueuedPrompts` dep lets a future wiring surface real counts.
 *
 * Chord sourcing: `session_queued_prompts` ('<leader>q') IS in keybind.ts; the
 * session-tree and prompt-stash chords are NOT yet registered there (T2/T4
 * shipped only `session_queued_prompts`), so they are defined LOCALLY here.
 * They should migrate to keybind.ts (keymap-file lane) to become rebindable.
 *
 * Priority: -100 (same as the messages.* layer, T10), so the bare
 * `up`/`right`/`left` session-tree chords lose to the managed textarea layer
 * (priority 0, binds `input_move_*`) WHILE the textarea is focused — editing
 * stays sacred — and win when it is blurred. The `<leader>...` chords have no
 * higher-priority binding, so they fire regardless of focus.
 *
 * Module-graph safety: imports only `@opentui/keymap` types (erased at compile
 * time) and the pure-data keybind.ts registry. NO `@opentui/core`. Dynamically
 * imported by the opentui bridge (TUI path only) so --no-tui stays clean.
 */

import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import { CommandMap, expandToChords, Keybinds } from './keybind.js';

// ---------------------------------------------------------------------------
// Session-tree direction
// ---------------------------------------------------------------------------

export type SessionTreeDirection = 'parent' | 'next-child' | 'prev-child' | 'first-child';

// ---------------------------------------------------------------------------
// Prompt stash: in-memory LIFO store (mirrors opencode prompt/stash.tsx shape)
// ---------------------------------------------------------------------------

export interface PromptStashEntry {
    readonly text: string;
    readonly cursor: number;
}

/** Cap matches opencode's MAX_STASH_ENTRIES so overflow drops the oldest. */
export const MAX_STASH_ENTRIES = 50;

/**
 * Minimal in-memory LIFO prompt stash. One instance per session (the layer
 * owns it; each ChatRoot mount = one session). Not persisted (unlike opencode's
 * file-backed variant) — the task mandates MINIMAL in-memory.
 */
export class PromptStash {
    private readonly entries: PromptStashEntry[] = [];

    push(entry: PromptStashEntry): void {
        this.entries.push(entry);
        if (this.entries.length > MAX_STASH_ENTRIES) {
            // Drop the OLDEST (front); LIFO top stays the most-recent push.
            this.entries.shift();
        }
    }

    /** Pop the most-recent push (LIFO). `undefined` when empty. */
    pop(): PromptStashEntry | undefined {
        return this.entries.pop();
    }

    get size(): number {
        return this.entries.length;
    }
}

// ---------------------------------------------------------------------------
// Queued-prompts view model (empty-state; data source verified unavailable)
// ---------------------------------------------------------------------------

export interface QueuedPromptsSnapshot {
    readonly pendingSteers: number;
    readonly pendingQueued: number;
    /** `false` while no runtime queue reader is wired into the TUI. */
    readonly observable: boolean;
}

/**
 * Format the queued-prompts view notice. When `observable === false` (the
 * current interactive-mode reality), names the limitation honestly instead of
 * pretending a count. When a real reader is wired (`observable === true`),
 * lists the pending steer + queue counts.
 */
export function buildQueuedPromptsNotice(snapshot: QueuedPromptsSnapshot): string {
    if (!snapshot.observable) {
        return 'Queued prompts: unavailable in interactive mode (no pending-queue read)\n';
    }
    return `Queued prompts: ${snapshot.pendingSteers} steer(s), ${snapshot.pendingQueued} queued\n`;
}

// ---------------------------------------------------------------------------
// Dependencies injected by the bridge ChatRoot (kept decoupled from internals)
// ---------------------------------------------------------------------------

export interface SessionShortcutsDeps {
    /**
     * Resolve a session-tree direction through the same path as `/tree`
     * `/branch` (the bridge enqueues the slash command line). Called for
     * up/right/left/<leader>down.
     */
    readonly navigateSessionTree: (direction: SessionTreeDirection) => void;
    /** Capture the current draft (text + cursor) for stashing. */
    readonly captureInput: () => PromptStashEntry;
    /** Clear the input buffer (called right after a successful stash capture). */
    readonly clearInput: () => void;
    /** Restore a stashed draft EXACTLY (text + cursor). */
    readonly restoreInput: (entry: PromptStashEntry) => void;
    /** Surface a one-line notice (bridge.emitOutput). */
    readonly emitNotice: (text: string) => void;
    /**
     * Optional pending-queue reader. Absent while the interactive TUI has no
     * observable queue (verified: SessionInputDelivery is workflow-path only),
     * so the view renders the documented empty-state.
     */
    readonly readQueuedPrompts?: () => QueuedPromptsSnapshot;
}

export interface SessionShortcutsLayerOptions {
    /**
     * Pre-built stash (lets tests seed/inspect). Defaults to a fresh
     * per-session instance owned by the layer.
     */
    readonly stash?: PromptStash;
}

// ---------------------------------------------------------------------------
// Chord sourcing
// ---------------------------------------------------------------------------

/**
 * Session-tree + prompt-stash chords. Defined locally because keybind.ts
 * (keymap-file lane) does not yet register `session.tree.*` / `prompt.stash*`
 * commands — only `session_queued_prompts` shipped in T2/T4. The bare
 * `up`/`right`/`left` collide with `input_move_*` and are resolved by layer
 * priority (see file header): they fire only while the textarea is blurred.
 */
const SESSION_TREE_AND_STASH_BINDINGS = [
    { key: 'up', cmd: 'session.tree.parent' },
    { key: 'right', cmd: 'session.tree.child_next' },
    { key: 'left', cmd: 'session.tree.child_previous' },
    { key: '<leader>down', cmd: 'session.tree.child_first' },
    { key: '<leader>s', cmd: 'prompt.stash' },
    { key: '<leader>p', cmd: 'prompt.stash.pop' },
    { key: '<leader>i', cmd: 'prompt.stash.list' },
] as const;

/** Build the full binding set: registry-sourced queued-prompts + local chords. */
function sessionShortcutBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly { readonly key: string; readonly cmd: string }[] {
    // session_queued_prompts IS rebindable in keybind.ts; source from there.
    const queuedChords = expandToChords(keybinds.session_queued_prompts).map((key) => ({
        key,
        cmd: CommandMap.session_queued_prompts,
    }));
    return [...SESSION_TREE_AND_STASH_BINDINGS, ...queuedChords];
}

// ---------------------------------------------------------------------------
// Layer registration
// ---------------------------------------------------------------------------

/**
 * Same negative priority as the messages.* layer (T10): below the managed
 * textarea layer (priority 0) so the bare `up`/`right`/`left` session-tree
 * chords yield to `input_move_*` while the textarea is focused. The
 * `<leader>...` chords have no higher-priority binding and fire regardless.
 */
export const SESSION_SHORTCUTS_LAYER_PRIORITY = -100;

/**
 * Register the session-tree + prompt-stash + queued-prompts layer onto
 * `keymap`. Generic over the keymap's target/event types so a real
 * `Keymap<Renderable, KeyEvent>` and a test `Keymap<TestKeymapTarget,
 * TestKeymapEvent>` both satisfy it without casts (same pattern as
 * `registerMessagesScrollLayer`, T10).
 *
 * Returns the layer disposer. The layer is SESSION-scoped (`enabled: () => true`
 * within the ChatRoot mount = session active).
 */
export function registerSessionShortcutsLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    deps: SessionShortcutsDeps,
    options: SessionShortcutsLayerOptions = {},
): () => void {
    const stash = options.stash ?? new PromptStash();

    const stashCountNotice = (): string => `Prompt stash: ${stash.size} stashed draft(s)\n`;

    const commands: readonly Command<TTarget, TEvent>[] = [
        {
            name: 'session.tree.parent',
            desc: 'Navigate to the parent session in the tree',
            run: () => {
                deps.navigateSessionTree('parent');
                return true;
            },
        },
        {
            name: 'session.tree.child_next',
            desc: 'Navigate to the next child session',
            run: () => {
                deps.navigateSessionTree('next-child');
                return true;
            },
        },
        {
            name: 'session.tree.child_previous',
            desc: 'Navigate to the previous child session',
            run: () => {
                deps.navigateSessionTree('prev-child');
                return true;
            },
        },
        {
            name: 'session.tree.child_first',
            desc: 'Navigate to the first child session',
            run: () => {
                deps.navigateSessionTree('first-child');
                return true;
            },
        },
        {
            name: CommandMap.session_queued_prompts,
            desc: 'Manage queued prompts',
            run: () => {
                const snapshot = deps.readQueuedPrompts?.() ?? {
                    pendingSteers: 0,
                    pendingQueued: 0,
                    observable: false,
                };
                deps.emitNotice(buildQueuedPromptsNotice(snapshot));
                return true;
            },
        },
        {
            name: 'prompt.stash',
            desc: 'Stash the current prompt draft',
            run: () => {
                stash.push(deps.captureInput());
                deps.clearInput();
                deps.emitNotice(stashCountNotice());
                return true;
            },
        },
        {
            name: 'prompt.stash.pop',
            desc: 'Restore the most-recent stashed prompt draft',
            run: () => {
                const entry = stash.pop();
                // Empty-pop is a documented no-op: no restore, no buffer clear.
                if (entry === undefined) {
                    deps.emitNotice('Prompt stash: empty\n');
                    return false;
                }
                deps.restoreInput(entry);
                return true;
            },
        },
        {
            name: 'prompt.stash.list',
            desc: 'Show the prompt stash count',
            run: () => {
                deps.emitNotice(stashCountNotice());
                return true;
            },
        },
    ];

    return keymap.registerLayer({
        priority: SESSION_SHORTCUTS_LAYER_PRIORITY,
        enabled: () => true,
        commands,
        bindings: sessionShortcutBindings(),
    });
}
