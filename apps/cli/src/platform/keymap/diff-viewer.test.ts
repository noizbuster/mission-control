/**
 * T14 failing-first proof: full-screen diff viewer overlay.
 *
 * The DiffViewerOverlay component (diff-viewer.tsx) cannot be rendered in unit
 * tests (no react-dom / react-test-renderer / DOM env; the plan forbids adding
 * deps). Its module IS FFI-safe to import, though: it pulls the diff renderer
 * (`render-diff` + `DiffView`), `hasDiffContent`, opentui type helpers, and the
 * bridge's `parseMessageBlocks` — none of which load the native FFI backend at
 * module evaluation (verified: jsx-runtime is a one-line re-export; the bridge
 * module's FFI imports are dynamic, inside `createOpenTuiChatBridge`). So this
 * suite drives the PURE collection + navigation helpers, mirroring the T8/T9/T10
 * pattern (pure helpers + tmux for live render).
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert the viewer lists REAL diffs with the
 *    exact file titles (not just "non-empty"), and that j/k move the cursor by
 *    an EXACT delta (not just "changed").
 *  - stale_state: open with ZERO diffs yields an empty entries list + the
 *    empty-state is reachable; close resets active to false; nav is a no-op on
 *    an empty model.
 *  - others (prompt_injection/cancel_resume/...): N/A — pure synchronous
 *    transforms over outputText, no async, no I/O, no process control.
 */

import { describe, expect, it } from 'vitest';
import { createOpenTuiChatBridgeCore, handleInput, type InkKeyShape } from '../../commands/opentui-chat-bridge.js';
import {
    buildDiffViewerModel,
    closeDiffViewerState,
    collectDiffEntries,
    moveLine,
    nextFile,
    nextHunk,
    openDiffViewerState,
    prevFile,
    prevHunk,
} from './diff-viewer.js';

// ---------------------------------------------------------------------------
// Fixtures: realistic mctrl outputText with tool diff blocks.
// ---------------------------------------------------------------------------

/** Two separate tool diff blocks (each preceded by a strong `Assistant:` line). */
const TWO_FILE_OUTPUT = [
    'You: edit foo and bar',
    'Assistant: editing now',
    'Edit preview for src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,3 @@',
    ' context line',
    '-old foo line',
    '+new foo line',
    ' trailing context',
    'You: also edit bar',
    'Assistant: done',
    'Edit preview for src/bar.ts',
    '--- a/src/bar.ts',
    '+++ b/src/bar.ts',
    '@@ -10,2 +10,2 @@',
    ' bar context',
    '-bar old',
    '+bar new',
].join('\n');

/**
 * A SINGLE tool block containing two `Edit preview for` titles with no strong
 * boundary between them — exercises the within-block split.
 */
const MERGED_TWO_FILE_OUTPUT = [
    'Edit preview for src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    'Edit preview for src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,1 +1,1 @@',
    '-c',
    '+d',
].join('\n');

/**
 * A tool block whose title is NOT a `preview for`/`Applied` file prefix (so the
 * title falls back to the `+++ b/` path). The block is still a tool block
 * because `Command output for ` is a tool-line prefix in `parseMessageBlocks`.
 */
const UNTITLED_DIFF_OUTPUT = [
    'Assistant: applying',
    'Command output for git diff',
    '--- a/src/untitled.ts',
    '+++ b/src/untitled.ts',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
].join('\n');

// ---------------------------------------------------------------------------
// collectDiffEntries
// ---------------------------------------------------------------------------

describe('collectDiffEntries', () => {
    it('lists one entry per tool diff block with the file title (acceptance a)', () => {
        const entries = collectDiffEntries(TWO_FILE_OUTPUT);
        expect(entries.map((entry) => entry.title)).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('splits a merged tool block into per-file entries at title boundaries', () => {
        const entries = collectDiffEntries(MERGED_TWO_FILE_OUTPUT);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('falls back to the +++ b/ path when no preview title prefix exists', () => {
        const entries = collectDiffEntries(UNTITLED_DIFF_OUTPUT);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.title).toBe('src/untitled.ts');
    });

    it('reuses renderDiff: entry lines carry green/red/cyan kinds (no duplicate logic)', () => {
        const entries = collectDiffEntries(TWO_FILE_OUTPUT);
        const foo = entries[0];
        expect(foo).toBeDefined();
        const kinds = foo?.lines.map((line) => line.kind);
        // Expect at least one each of added/removed/hunk/meta from the foo block.
        expect(kinds).toContain('hunk');
        expect(kinds).toContain('removed');
        expect(kinds).toContain('added');
        expect(kinds).toContain('meta');
    });

    it('returns an empty list when there are no diffs (stale_state / acceptance c)', () => {
        expect(collectDiffEntries('')).toEqual([]);
        expect(collectDiffEntries('You: hi\nAssistant: hello there\n')).toEqual([]);
        // A tool block WITHOUT diff-like lines (+/-/@@) is excluded. Note the
        // reused `hasDiffContent` treats any `+`/`-`/`@@` line as diff content,
        // so a genuine command output with no such markers is the clean case.
        expect(collectDiffEntries('Command output for echo hello\nhello world\n')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// buildDiffViewerModel
// ---------------------------------------------------------------------------

describe('buildDiffViewerModel', () => {
    it('computes flat total lines, per-entry start offsets, and hunk positions', () => {
        const entries = collectDiffEntries(TWO_FILE_OUTPUT);
        const model = buildDiffViewerModel(entries);
        // Two non-empty entries.
        expect(entries).toHaveLength(2);
        const first = entries[0];
        const second = entries[1];
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        if (first === undefined || second === undefined) return;
        expect(model.entries).toHaveLength(2);
        const firstStart = model.entryStarts[0] ?? 0;
        const secondStart = model.entryStarts[1] ?? first.lines.length;
        expect(firstStart).toBe(0);
        // Second entry starts right after the first entry's line count.
        expect(secondStart).toBe(first.lines.length);
        expect(model.totalLines).toBe(first.lines.length + second.lines.length);
        // Each file has exactly one @@ hunk header.
        expect(model.hunkLineIndices).toHaveLength(2);
        expect(model.hunkLineIndices[0]).toBe(firstStart + hunkOffset(first));
        expect(model.hunkLineIndices[1]).toBe(secondStart + hunkOffset(second));
    });

    it('produces a zero-lines model for an empty entry list', () => {
        const model = buildDiffViewerModel(collectDiffEntries(''));
        expect(model.totalLines).toBe(0);
        expect(model.entryStarts).toEqual([]);
        expect(model.hunkLineIndices).toEqual([]);
    });
});

/** Index of the first `hunk`-kind line within an entry (helper for assertions). */
function hunkOffset(entry: { readonly lines: ReadonlyArray<{ readonly kind: string }> }): number {
    return entry.lines.findIndex((line) => line.kind === 'hunk');
}

// ---------------------------------------------------------------------------
// Navigation reducers
// ---------------------------------------------------------------------------

describe('moveLine', () => {
    it('moves the cursor by the delta (acceptance b: j/k move)', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        expect(moveLine(model, 0, 1)).toBe(1);
        expect(moveLine(model, 1, 1)).toBe(2);
        expect(moveLine(model, 2, -1)).toBe(1);
    });

    it('clamps at the buffer bounds (no overflow / no negative)', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const last = model.totalLines - 1;
        expect(moveLine(model, last, 1)).toBe(last);
        expect(moveLine(model, 0, -1)).toBe(0);
    });

    it('is a no-op returning 0 on an empty model (stale_state)', () => {
        const model = buildDiffViewerModel(collectDiffEntries(''));
        expect(moveLine(model, 0, 1)).toBe(0);
        expect(moveLine(model, 0, -1)).toBe(0);
    });
});

describe('nextHunk / prevHunk', () => {
    it('jumps forward to the next @@ hunk (acceptance b: ] jumps to next hunk)', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const firstHunk = model.hunkLineIndices[0] ?? 0;
        const secondHunk = model.hunkLineIndices[1] ?? 0;
        // From the first hunk, ] lands on the second hunk.
        expect(nextHunk(model, firstHunk)).toBe(secondHunk);
    });

    it('stays put when already on the last hunk (no wraparound)', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const lastHunk = model.hunkLineIndices[model.hunkLineIndices.length - 1] ?? 0;
        expect(nextHunk(model, lastHunk)).toBe(lastHunk);
    });

    it('jumps backward to the previous @@ hunk', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const firstHunk = model.hunkLineIndices[0] ?? 0;
        const secondHunk = model.hunkLineIndices[1] ?? 0;
        expect(prevHunk(model, secondHunk)).toBe(firstHunk);
    });

    it('stays put when already on the first hunk', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const firstHunk = model.hunkLineIndices[0] ?? 0;
        expect(prevHunk(model, firstHunk)).toBe(firstHunk);
    });
});

describe('nextFile / prevFile', () => {
    it('jumps to the start of the next file', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        expect(nextFile(model, 0)).toBe(model.entryStarts[1]);
    });

    it('stays put on the last file', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const lastStart = model.entryStarts[model.entryStarts.length - 1] ?? 0;
        expect(nextFile(model, lastStart)).toBe(lastStart);
    });

    it('jumps to the start of the previous file', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        const secondStart = model.entryStarts[1] ?? 0;
        expect(prevFile(model, secondStart)).toBe(model.entryStarts[0]);
    });

    it('stays at 0 on the first file', () => {
        const model = buildDiffViewerModel(collectDiffEntries(TWO_FILE_OUTPUT));
        expect(prevFile(model, 0)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Open / close state
// ---------------------------------------------------------------------------

describe('openDiffViewerState / closeDiffViewerState', () => {
    it('open lists files with diffs and marks the viewer active (acceptance a)', () => {
        const state = openDiffViewerState(TWO_FILE_OUTPUT);
        expect(state.active).toBe(true);
        expect(state.cursor).toBe(0);
        expect(state.entries.map((entry) => entry.title)).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('open with zero diffs still activates the viewer with an empty list (acceptance c)', () => {
        const state = openDiffViewerState('You: hi\nAssistant: hello\n');
        expect(state.active).toBe(true);
        expect(state.entries).toEqual([]);
        expect(state.cursor).toBe(0);
    });

    it('close deactivates the viewer and clears entries + cursor (acceptance c: esc closes)', () => {
        const closed = closeDiffViewerState();
        expect(closed.active).toBe(false);
        expect(closed.entries).toEqual([]);
        expect(closed.cursor).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Bridge integration: drive handleInput -> handleDiffViewerInput on a real core
// ---------------------------------------------------------------------------

function makeKey(overrides: Partial<InkKeyShape> = {}): InkKeyShape {
    return {
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
    };
}

/** Open the viewer on a fresh core (mirrors the bridgeSubmit `/diff` path). */
function openOnCore(outputText: string) {
    const core = createOpenTuiChatBridgeCore();
    core.outputText = outputText;
    core.diffViewerEntries = collectDiffEntries(core.outputText);
    core.diffViewerCursor = 0;
    core.diffViewerActive = true;
    return core;
}

describe('bridge handleInput wiring (acceptance a/b/c through the real handler)', () => {
    it('j/k move the cursor through handleInput (acceptance b)', () => {
        const core = openOnCore(TWO_FILE_OUTPUT);
        expect(core.diffViewerCursor).toBe(0);
        handleInput(core, 'j', makeKey());
        expect(core.diffViewerCursor).toBe(1);
        handleInput(core, 'j', makeKey());
        expect(core.diffViewerCursor).toBe(2);
        handleInput(core, 'k', makeKey());
        expect(core.diffViewerCursor).toBe(1);
    });

    it('] jumps to the next hunk through handleInput (acceptance b)', () => {
        const core = openOnCore(TWO_FILE_OUTPUT);
        const model = buildDiffViewerModel(core.diffViewerEntries);
        const firstHunk = model.hunkLineIndices[0] ?? 0;
        const secondHunk = model.hunkLineIndices[1] ?? 0;
        // From cursor 0, ] jumps to the first hunk past 0.
        handleInput(core, ']', makeKey());
        expect(core.diffViewerCursor).toBe(firstHunk);
        // From the first hunk, ] jumps to the second.
        handleInput(core, ']', makeKey());
        expect(core.diffViewerCursor).toBe(secondHunk);
    });

    it('esc closes the viewer and publishes the closed snapshot (acceptance c)', () => {
        const core = openOnCore(TWO_FILE_OUTPUT);
        handleInput(core, '', makeKey({ escape: true }));
        expect(core.diffViewerActive).toBe(false);
        expect(core.diffViewerEntries).toEqual([]);
        expect(core.diffViewerCursor).toBe(0);
        // publishSnapshot ran: the snapshot reflects the closed state.
        expect(core.snapshot.diffViewerActive).toBe(false);
    });

    it('q also closes the viewer', () => {
        const core = openOnCore(TWO_FILE_OUTPUT);
        handleInput(core, 'q', makeKey());
        expect(core.diffViewerActive).toBe(false);
    });

    it('nav is a no-op on an empty viewer, but esc still closes (acceptance c)', () => {
        const core = openOnCore('You: hi\nAssistant: hello\n');
        expect(core.diffViewerEntries).toEqual([]);
        handleInput(core, 'j', makeKey());
        expect(core.diffViewerCursor).toBe(0);
        handleInput(core, ']', makeKey());
        expect(core.diffViewerCursor).toBe(0);
        handleInput(core, '', makeKey({ escape: true }));
        expect(core.diffViewerActive).toBe(false);
    });

    it('Ctrl+C is NOT swallowed by the diff viewer (routes to the global interrupt sink)', () => {
        const core = openOnCore(TWO_FILE_OUTPUT);
        // Ctrl+C must fall through handleDiffViewerInput to the global interrupt
        // path, enqueuing an interrupt event (the exit contract is untouched).
        handleInput(core, 'c', makeKey({ ctrl: true }));
        expect(core.diffViewerActive).toBe(true);
        expect(core.eventQueue).toHaveLength(1);
        expect(core.eventQueue[0]?.type).toBe('interrupt');
    });
});
