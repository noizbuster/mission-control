/** @jsxImportSource @opentui/react */
// allow: SIZE_OK — task FILE LANE permits only diff-viewer.* (one source file);
// the module owns one cohesive feature (collect + navigate + render session
// diffs). Mirrors keybind.ts (363) / model-favorites.ts (305) single-file lanes.
/**
 * T14: full-screen diff viewer overlay (keyboard navigation).
 *
 * Reuses the existing inline diff renderer (`DiffView` + `renderDiff`) for the
 * actual diff rendering — it does NOT duplicate diff classification or
 * intra-line highlighting logic. New logic here is limited to:
 *   - collecting per-file diff entries from the session `outputText`
 *     (classifying which tool blocks carry diffs via the shared
 *     `parseMessageBlocks` + `hasDiffContent`, then splitting merged tool
 *     blocks at file-title boundaries);
 *   - a flat navigation model (entry starts + hunk positions) and the
 *     `j/k`/`][`/`n/p` reducers that the bridge's `handleDiffViewerInput`
 *     drives;
 *   - the overlay component itself.
 *
 * The overlay mirrors the model-picker/approval overlay pattern: the bridge
 * owns `diffViewerActive` (+ entries + cursor) on its core; when active the
 * textarea blurs so keystrokes route to `handleDiffViewerInput` via the global
 * `useKeyboard` sink, and `ChatRoot` renders `<DiffViewerOverlay>`.
 *
 * Module-graph safety: imports `render-diff` (the `diff` lib, FFI-free),
 * `DiffView` + `ToolCard` (opentui-pragmatic `.tsx` whose jsx-runtime is a
 * one-line re-export of react's jsx-runtime — FFI-free), opentui type helpers
 * (FFI-free), and `parseMessageBlocks` from the bridge (whose FFI imports are
 * dynamic, inside `createOpenTuiChatBridge`). So importing this module never
 * loads the native backend; it is unit-testable headlessly.
 */

import type React from 'react';
import { type ChatBlock, parseMessageBlocks } from '../../commands/chat-blocks.js';
import { DiffView } from '../../components/diff/DiffView.js';
import { type DiffLine, renderDiff } from '../../components/diff/render-diff.js';
import { hasDiffContent } from '../../components/ToolCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One file's diff: a human title plus the rendered `DiffLine[]` to display. */
export type DiffEntry = {
    readonly title: string;
    readonly lines: readonly DiffLine[];
};

/**
 * Flat navigation model derived from a list of entries. `entryStarts[i]` is the
 * flat line offset where entry `i` begins; `hunkLineIndices` are the flat line
 * indices of every `@@` hunk header (kind === 'hunk'), ascending.
 */
export type DiffViewerModel = {
    readonly entries: readonly DiffEntry[];
    readonly totalLines: number;
    readonly entryStarts: readonly number[];
    readonly hunkLineIndices: readonly number[];
};

/** Pure open/close representation the bridge maps onto its core fields. */
export type DiffViewerState = {
    readonly active: boolean;
    readonly entries: readonly DiffEntry[];
    readonly cursor: number;
};

// ---------------------------------------------------------------------------
// Collection: outputText -> DiffEntry[]
// ---------------------------------------------------------------------------

/**
 * Tool-block title prefixes that introduce a file path. Used to split a single
 * merged tool block into per-file diff entries (mctrl emits one `Edit preview
 * for <path>` header per edited file; without a strong boundary between them
 * `parseMessageBlocks` absorbs them into one tool block).
 */
const FILE_TITLE_PREFIXES = [
    'Edit preview for ',
    'Patch preview for ',
    'Write preview for ',
    'Replace preview for ',
    'Create preview for ',
    'Applied patch: ',
    'Applied edit: ',
    'Created file: ',
    'Replaced file: ',
] as const;

function matchFileTitlePrefix(line: string): string | undefined {
    for (const prefix of FILE_TITLE_PREFIXES) {
        if (line.startsWith(prefix)) return prefix;
    }
    return undefined;
}

/** Extract a file path from `+++ b/<path>` / `--- a/<path>` meta lines. */
function pathFromMetaLines(lines: readonly string[]): string | undefined {
    for (const line of lines) {
        if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length).trim();
    }
    for (const line of lines) {
        if (line.startsWith('--- a/')) return line.slice('--- a/'.length).trim();
    }
    return undefined;
}

type EntrySegment = { readonly title: string | undefined; readonly body: readonly string[] };

/**
 * Split a single tool block's lines into per-file segments at file-title
 * prefixes. Lines before the first title prefix form a (title-less) segment so
 * a block with no title header still yields one entry.
 */
function splitToolBlockIntoSegments(lines: readonly string[]): readonly EntrySegment[] {
    const segments: EntrySegment[] = [];
    let currentTitle: string | undefined;
    let currentBody: string[] = [];
    let started = false;
    for (const line of lines) {
        const prefix = matchFileTitlePrefix(line);
        if (prefix !== undefined) {
            if (started) segments.push({ title: currentTitle, body: currentBody });
            currentTitle = line.slice(prefix.length).trim();
            currentBody = [];
            started = true;
        } else {
            currentBody.push(line);
            started = true;
        }
    }
    if (started) segments.push({ title: currentTitle, body: currentBody });
    return segments;
}

function titleForSegment(segment: EntrySegment, fallbackIndex: number): string {
    if (segment.title !== undefined && segment.title.length > 0) return segment.title;
    const fromMeta = pathFromMetaLines(segment.body);
    if (fromMeta !== undefined && fromMeta.length > 0) return fromMeta;
    return `Diff ${fallbackIndex + 1}`;
}

/**
 * Collect per-file diff entries from the session `outputText`. Reuses
 * `parseMessageBlocks` (the canonical block splitter) and `hasDiffContent` to
 * find tool blocks that carry diffs, then splits each into one entry per file.
 * Never throws; returns `[]` when no diffs are present.
 */
export function collectDiffEntries(outputText: string): readonly DiffEntry[] {
    const blocks: readonly ChatBlock[] = parseMessageBlocks(outputText);
    const entries: DiffEntry[] = [];
    for (const block of blocks) {
        if (block.kind !== 'tool' || !hasDiffContent(block.lines)) continue;
        for (const segment of splitToolBlockIntoSegments(block.lines)) {
            if (!hasDiffContent(segment.body)) continue;
            const diffLines = renderDiff(segment.body.join('\n'));
            if (diffLines.length === 0) continue;
            entries.push({ title: titleForSegment(segment, entries.length), lines: diffLines });
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Navigation model + reducers (pure)
// ---------------------------------------------------------------------------

export function buildDiffViewerModel(entries: readonly DiffEntry[]): DiffViewerModel {
    const entryStarts: number[] = [];
    const hunkLineIndices: number[] = [];
    let offset = 0;
    for (const entry of entries) {
        entryStarts.push(offset);
        for (let i = 0; i < entry.lines.length; i++) {
            if ((entry.lines[i] ?? { kind: '' }).kind === 'hunk') {
                hunkLineIndices.push(offset + i);
            }
        }
        offset += entry.lines.length;
    }
    return { entries, totalLines: offset, entryStarts, hunkLineIndices };
}

/** Largest entry index whose start offset is `<= cursor` (0 when none). */
function entryIndexAt(model: DiffViewerModel, cursor: number): number {
    let index = 0;
    for (let i = 0; i < model.entryStarts.length; i++) {
        if ((model.entryStarts[i] ?? 0) <= cursor) index = i;
        else break;
    }
    return index;
}

function clampCursor(model: DiffViewerModel, value: number): number {
    if (model.totalLines <= 0) return 0;
    return Math.min(Math.max(value, 0), model.totalLines - 1);
}

/** `j`/`k`: move the cursor by `delta` lines, clamped to the buffer bounds. */
export function moveLine(model: DiffViewerModel, cursor: number, delta: number): number {
    return clampCursor(model, cursor + delta);
}

/** `]`: jump to the next hunk header strictly past `cursor` (no wraparound). */
export function nextHunk(model: DiffViewerModel, cursor: number): number {
    for (const index of model.hunkLineIndices) {
        if (index > cursor) return index;
    }
    return cursor;
}

/** `[`: jump to the previous hunk header strictly before `cursor`. */
export function prevHunk(model: DiffViewerModel, cursor: number): number {
    let found: number | undefined;
    for (const index of model.hunkLineIndices) {
        if (index < cursor) found = index;
        else break;
    }
    return found ?? cursor;
}

/** `n`: jump to the start of the next file (entry) past `cursor`. */
export function nextFile(model: DiffViewerModel, cursor: number): number {
    for (const start of model.entryStarts) {
        if (start > cursor) return start;
    }
    return cursor;
}

/** `p`: jump to the start of the previous file (entry) before the current one. */
export function prevFile(model: DiffViewerModel, cursor: number): number {
    if (model.entryStarts.length === 0) return cursor;
    const currentIndex = entryIndexAt(model, cursor);
    if (currentIndex > 0) return model.entryStarts[currentIndex - 1] ?? cursor;
    return model.entryStarts[0] ?? cursor;
}

// ---------------------------------------------------------------------------
// Open / close state
// ---------------------------------------------------------------------------

export function openDiffViewerState(outputText: string): DiffViewerState {
    return { active: true, entries: collectDiffEntries(outputText), cursor: 0 };
}

export function closeDiffViewerState(): DiffViewerState {
    return { active: false, entries: [], cursor: 0 };
}

// ---------------------------------------------------------------------------
// Overlay component (reuses <DiffView> for the diff rendering)
// ---------------------------------------------------------------------------

export type DiffViewerOverlayProps = {
    readonly entries: readonly DiffEntry[];
    readonly model: DiffViewerModel;
    readonly cursor: number;
};

/**
 * Full-screen diff viewer. Renders one `<DiffView>` per file entry (reusing the
 * existing renderer — no duplicated diff logic) with the current file's title
 * highlighted and a status line tracking the cursor position. Keyboard nav is
 * driven by the bridge's `handleDiffViewerInput` (`j`/`k`/`]`/`[`/`n`/`p`/`esc`/`q`).
 */
export function DiffViewerOverlay({ entries, model, cursor }: DiffViewerOverlayProps): React.ReactNode {
    const currentEntryIndex = entries.length === 0 ? -1 : entryIndexAt(model, cursor);
    return (
        <box flexDirection="column" paddingTop={1} paddingX={1}>
            <text fg="#00ffff" {...{ bold: true, inverse: true }}>
                {' Diff Viewer '}
            </text>
            {entries.length === 0 ? (
                <>
                    <text marginTop={1}>No file diffs in this session yet.</text>
                    <text {...{ dim: true }}>Press Esc or q to close.</text>
                </>
            ) : (
                <>
                    <box flexDirection="column" marginTop={1}>
                        {entries.map((entry, index) => {
                            const isCurrent = index === currentEntryIndex;
                            return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: diff entries are positional within a single overlay render
                                <box key={`dventry-${index}`} flexDirection="column">
                                    <text
                                        {...(isCurrent ? { bg: '#0000ff' } : {})}
                                        {...{ bold: true }}
                                    >
                                        {isCurrent ? '> ' : '  '}
                                        {entry.title}
                                    </text>
                                    <DiffView lines={entry.lines} />
                                </box>
                            );
                        })}
                    </box>
                    <box marginTop={1}>
                        <text {...{ dim: true }}>
                            {`File ${currentEntryIndex + 1}/${entries.length} \u00b7 Line ${cursor + 1}/${model.totalLines}`}
                        </text>
                    </box>
                    <text {...{ dim: true }}>
                        {'j/k move \u00b7 ]/[ hunk \u00b7 n/p file \u00b7 Esc/q close'}
                    </text>
                </>
            )}
        </box>
    );
}
