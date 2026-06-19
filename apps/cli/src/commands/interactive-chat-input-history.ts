/**
 * Pure input-history reducer for the interactive chat input box.
 *
 * The Ink chat bridge keeps a {@link ChatInputHistory} value in its core state.
 * Every non-empty submitted line (prompts and slash commands alike) is recorded
 * so the user can recall anything they previously typed.
 *
 * Entries are stored oldest→newest. A virtual "draft" slot sits just past the
 * newest entry at index `entries.length`. Pressing Up moves toward older entries;
 * pressing Down moves toward the draft slot. The current input is captured as
 * `draft` the moment the user first leaves the draft slot, and is restored when
 * they navigate back down past the newest entry — matching familiar shell
 * (readline) semantics.
 *
 * The module is intentionally pure: the bridge threads the value through its
 * `handleInput` reducer and applies the returned `input` to `inputBuffer`. This
 * keeps the state machine unit-testable without mounting Ink.
 */

export type ChatInputHistory = {
    /** Submitted prompts, oldest first, newest last. */
    readonly entries: readonly string[];
    /**
     * Cursor into the virtual list of `entries.length + 1` slots.
     * `entries.length` means the draft slot (the in-progress new input).
     * Any smaller value points at `entries[cursor]`.
     */
    readonly cursor: number;
    /** Input captured when the user first navigated up off the draft slot. */
    readonly draft: string;
};

export type ChatInputHistoryNavigation = {
    readonly history: ChatInputHistory;
    /** Text the caller should write into the input buffer. */
    readonly input: string;
};

export function createChatInputHistory(): ChatInputHistory {
    return { entries: [], cursor: 0, draft: '' };
}

/** True when the cursor points at a stored entry rather than the draft slot. */
export function isNavigatingChatInputHistory(history: ChatInputHistory): boolean {
    return history.cursor < history.entries.length;
}

/**
 * Records a submitted prompt and returns state reset to the draft slot.
 *
 * Empty values are not stored (they are not useful to recall), but the cursor is
 * still reset so navigation starts fresh on the next prompt.
 */
export function recordSubmittedPrompt(history: ChatInputHistory, value: string): ChatInputHistory {
    if (value.length === 0) {
        return { entries: history.entries, cursor: history.entries.length, draft: '' };
    }
    const entries = [...history.entries, value];
    return { entries, cursor: entries.length, draft: '' };
}

/**
 * Up arrow: move toward older entries.
 *
 * Captures the current input as the draft when leaving the draft slot. No-op
 * (returns the current input unchanged) when history is empty or the cursor is
 * already at the oldest entry.
 */
export function navigateChatInputHistoryUp(
    history: ChatInputHistory,
    currentInput: string,
): ChatInputHistoryNavigation {
    if (history.entries.length === 0 || history.cursor === 0) {
        return { history, input: currentInput };
    }
    const leavingDraft = history.cursor >= history.entries.length;
    const draft = leavingDraft ? currentInput : history.draft;
    const cursor = history.cursor - 1;
    return {
        history: { entries: history.entries, cursor, draft },
        input: history.entries[cursor] ?? '',
    };
}

/**
 * Down arrow: move toward the draft slot.
 *
 * Restores the draft input when arriving back at the draft slot. No-op (returns
 * the current input unchanged) when the cursor is already at the draft slot.
 */
export function navigateChatInputHistoryDown(
    history: ChatInputHistory,
    currentInput: string,
): ChatInputHistoryNavigation {
    if (history.cursor >= history.entries.length) {
        return { history, input: currentInput };
    }
    const cursor = history.cursor + 1;
    if (cursor >= history.entries.length) {
        return {
            history: { entries: history.entries, cursor: history.entries.length, draft: '' },
            input: history.draft,
        };
    }
    return {
        history: { entries: history.entries, cursor, draft: history.draft },
        input: history.entries[cursor] ?? '',
    };
}
