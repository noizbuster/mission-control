/**
 * Message undo/redo keymap layer (T15).
 *
 * Registers `messages.undo` (`<leader>u`) and `messages.redo` (`<leader>r`) as
 * a SESSION-scoped keymap layer that is NOT textarea-gated (the `<leader>`
 * chords have no higher-priority binding, so they fire regardless of input
 * focus — same posture as the rest of the messages.* layer, T10).
 *
 * NON-DESTRUCTIVE by design. Undo hides the last `You:` + `Assistant:`
 * exchange from the bridge's `outputText` VIEW (the chat display text) by
 * stashing the removed substring; redo re-appends it byte-exact. The durable
 * JSONL session log is NEVER touched: the layer's only mutation surface is the
 * injected `replaceOutputText` dep, which the bridge wires to
 * `replaceCoreOutputText` — a function that sets `core.outputText` and
 * publishes a snapshot and nothing else (no session-store call). The durable
 * `/fork`/`/branch` path remains the persistent alternative.
 *
 * SINGLE-LEVEL. At most one exchange is hidden at a time. A second undo while
 * one is already hidden is a no-op; redo clears the single stash slot. This is
 * intentional (the task forbids branching history) and keeps the runtime
 * bounded and reversible.
 *
 * The stash holds the raw removed SUBSTRING (not a parsed `MessagePair`) so
 * redo restores the original bytes exactly, including multi-line assistant
 * blocks and any trailing turn content. Extraction finds the last COMPLETE
 * exchange (the last `Assistant:` line plus the nearest preceding `You:` line)
 * and slices the outputText from that `You:` line's start offset to the end.
 *
 * Module-graph safety: imports only `@opentui/keymap` types (erased at compile
 * time) and the pure-data `keybind.ts` registry. NO `@opentui/core`, NO bridge
 * import. Dynamically imported by the opentui bridge (TUI path only) so
 * `--no-tui` stays clean. (Same posture as T10/T11/T12.)
 */

import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import { CommandMap, expandToChords, type InputBinding, type KeybindName, Keybinds } from './keybind.js';

// ---------------------------------------------------------------------------
// Pure extraction: byte-exact substring stash
// ---------------------------------------------------------------------------

const USER_PREFIX = 'You: ';
const ASSISTANT_PREFIX = 'Assistant: ';

/**
 * Line prefixes that start a new strong block (mirrors `parseMessageBlocks`
 * `isStrongBoundary` in the bridge, kept LOCAL so this module stays decoupled
 * from bridge internals — same self-contained posture as T10/T12). The
 * assistant block absorbs tool/system/blank continuation lines until the next
 * strong boundary, so the exchange's end is the line index of that boundary.
 */
const STRONG_BOUNDARY_PREFIXES: readonly string[] = [USER_PREFIX, ASSISTANT_PREFIX, 'Error: ', 'Thinking: '];

export interface ExtractedExchange {
    readonly exchangeText: string;
    readonly remaining: string;
    /** Byte offset where the exchange sat in the original outputText; redo re-inserts here. */
    readonly insertOffset: number;
}

/**
 * Find the last COMPLETE `You:` + `Assistant:` exchange in `outputText` and
 * return the substring to stash, the remaining text, and the offset to
 * re-insert at on redo. Returns `undefined` when no exchange exists (no
 * `Assistant:` line, or no `You:` line before it).
 *
 * The exchange spans from the last `You:` line that precedes the last
 * `Assistant:` line through the end of that assistant BLOCK (the next strong
 * boundary or end-of-text). An unanswered trailing `You:` is NOT part of an
 * exchange, so it stays visible. Slicing the original string (not a parsed
 * reconstruction) plus recording the insert offset guarantees
 * `remaining.slice(0,insertOffset) + exchangeText + remaining.slice(insertOffset) === outputText`
 * byte-for-byte, so redo restores the original exactly even when the exchange
 * was not at the tail.
 */
export function extractLastExchange(outputText: string): ExtractedExchange | undefined {
    const lines = outputText.split('\n');

    const assistantLineIndex = findLastLineWithPrefix(lines, ASSISTANT_PREFIX);
    if (assistantLineIndex === -1) return undefined;

    // The `You:` must precede the assistant line so an unanswered trailing
    // user message does not become the undo target — the last COMPLETE
    // exchange is what gets hidden.
    const userLineIndex = findLastLineWithPrefixBefore(lines, USER_PREFIX, assistantLineIndex);
    if (userLineIndex === -1) return undefined;

    // The assistant block ends at the next strong boundary (or end-of-text),
    // so multi-line assistant replies and their absorbed tool/system lines are
    // fully captured while a trailing unanswered `You:` stays in `remaining`.
    const blockEndLine = findStrongBoundaryAfter(lines, assistantLineIndex);

    const insertOffset = lineStartOffset(lines, userLineIndex);
    const blockEndOffset = lineStartOffset(lines, blockEndLine);
    return {
        exchangeText: outputText.slice(insertOffset, blockEndOffset),
        remaining: outputText.slice(0, insertOffset) + outputText.slice(blockEndOffset),
        insertOffset,
    };
}

function findLastLineWithPrefix(lines: readonly string[], prefix: string): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').startsWith(prefix)) return index;
    }
    return -1;
}

function findLastLineWithPrefixBefore(lines: readonly string[], prefix: string, before: number): number {
    for (let index = before - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').startsWith(prefix)) return index;
    }
    return -1;
}

/** Index of the first strong-boundary line strictly after `from` (exclusive), or `lines.length` when none. */
function findStrongBoundaryAfter(lines: readonly string[], from: number): number {
    for (let index = from + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (STRONG_BOUNDARY_PREFIXES.some((prefix) => line.startsWith(prefix))) return index;
    }
    return lines.length;
}

/** Character offset of the start of the `lineIndex`-th line (each line + its `\n`). */
function lineStartOffset(lines: readonly string[], lineIndex: number): number {
    let offset = 0;
    for (let index = 0; index < lineIndex; index += 1) {
        offset += (lines[index] ?? '').length + 1;
    }
    return offset;
}

// ---------------------------------------------------------------------------
// Config-driven bindings (sourced from the keybind.ts registry)
// ---------------------------------------------------------------------------

const MESSAGE_UNDO_REDO_BINDINGS = ['messages_undo', 'messages_redo'] as const satisfies readonly KeybindName[];

/**
 * Build the chord→command bindings for the two undo/redo commands from the
 * keybind.ts registry (config-driven, rebindable via T17 overrides). Both
 * defaults are `<leader>`-prefixed (`<leader>u`, `<leader>r`); the leader token
 * is resolved at the keymap level by `registerTimedLeader` (T7).
 */
export function messageUndoRedoBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly InputBinding[] {
    const result: InputBinding[] = [];
    for (const name of MESSAGE_UNDO_REDO_BINDINGS) {
        const cmd = CommandMap[name];
        if (cmd === undefined) continue;
        for (const chord of expandToChords(keybinds[name])) {
            result.push({ key: chord, cmd });
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Dependencies injected by the bridge ChatRoot (kept decoupled from internals)
// ---------------------------------------------------------------------------

export interface MessageUndoRedoDeps {
    /** Read the current chat VIEW text (`core.outputText`). */
    readonly getOutputText: () => string;
    /** Replace the VIEW text entirely (bridge wires this to `replaceCoreOutputText`). */
    readonly replaceOutputText: (text: string) => void;
    /** True while a provider turn is streaming (undo is a no-op then). */
    readonly isGenerating: () => boolean;
    /** Surface a one-line notice (bridge.emitOutput). */
    readonly emitNotice: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Layer registration
// ---------------------------------------------------------------------------

/**
 * Same negative priority as the rest of the messages.* layer (T10) and the
 * session-shortcuts layer (T12): below the managed textarea layer (priority 0).
 * The `<leader>u`/`<leader>r` chords have no higher-priority binding, so they
 * fire regardless of textarea focus.
 */
export const MESSAGE_UNDO_REDO_LAYER_PRIORITY = -100;

/**
 * Register the messages.undo / messages.redo layer onto `keymap`. Generic over
 * the keymap's target/event types so a real `Keymap<Renderable, KeyEvent>` and
 * a test `Keymap<TestKeymapTarget, TestKeymapEvent>` both satisfy it without
 * casts (same pattern as `registerMessagesScrollLayer`, T10).
 *
 * Returns the layer disposer. The layer is SESSION-scoped
 * (`enabled: () => true` within the ChatRoot mount = session active) and owns a
 * single-level in-memory stash (one hidden exchange at most).
 */
export function registerMessageUndoRedoLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    deps: MessageUndoRedoDeps,
): () => void {
    let stashed: { readonly text: string; readonly insertOffset: number } | undefined;

    const commands: readonly Command<TTarget, TEvent>[] = [
        {
            name: CommandMap.messages_undo,
            desc: 'Undo last message exchange',
            run: () => {
                if (deps.isGenerating()) {
                    deps.emitNotice('Cannot undo while generating.\n');
                    return false;
                }
                if (stashed !== undefined) {
                    deps.emitNotice('Nothing more to undo. Press leader+r to restore.\n');
                    return false;
                }
                const extracted = extractLastExchange(deps.getOutputText());
                if (extracted === undefined) {
                    deps.emitNotice('Nothing to undo.\n');
                    return false;
                }
                stashed = { text: extracted.exchangeText, insertOffset: extracted.insertOffset };
                deps.replaceOutputText(extracted.remaining);
                deps.emitNotice('Reverted last exchange. Press leader+r to restore.\n');
                return true;
            },
        },
        {
            name: CommandMap.messages_redo,
            desc: 'Redo last undone message exchange',
            run: () => {
                if (stashed === undefined) {
                    deps.emitNotice('Nothing to redo.\n');
                    return false;
                }
                // Re-insert at the original offset: byte-exact restore when
                // outputText is unchanged between undo and redo.
                const current = deps.getOutputText();
                const restored =
                    current.slice(0, stashed.insertOffset) + stashed.text + current.slice(stashed.insertOffset);
                deps.replaceOutputText(restored);
                stashed = undefined;
                deps.emitNotice('Restored exchange.\n');
                return true;
            },
        },
    ];

    return keymap.registerLayer({
        priority: MESSAGE_UNDO_REDO_LAYER_PRIORITY,
        enabled: () => true,
        commands,
        bindings: messageUndoRedoBindings(),
    });
}
