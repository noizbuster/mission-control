import { describe, expect, it } from 'vitest';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    isSlashCommandMenuOpen,
    isWorkflowCommandMenuOpen,
    reduceSlashCommandMenuSelection,
    reduceWorkflowCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
    resolveWorkflowCommandMenuInsertText,
    slashCommandChoices,
    type SlashCommandMenuChoice,
} from './interactive-chat-command-menu.js';
import {
    deleteTerminalChatInputCharacterBeforeCursor,
    formatTerminalChatCommittedInputLine,
    formatTerminalChatInputBlock,
    insertTerminalChatInputText,
    moveTerminalChatInputCursor,
    renderTerminalChatInputBlock,
} from './interactive-chat-input-block.js';
import {
    isTerminalShiftEnterSequence,
    terminalModifiedKeyDisableSequence,
    terminalModifiedKeyEnableSequence,
} from './interactive-chat-keyboard.js';

describe('interactive chat command menu', () => {
    it('opens slash commands, filters by typed query, and submits the arrow-selected command', () => {
        const initialState = createSlashCommandMenuState();
        const filteredView = createSlashCommandMenuView('/mo', initialState, 5);

        expect(filteredView.open).toBe(true);
        expect(filteredView.query).toBe('mo');
        expect(filteredView.visibleChoices.map((choice) => choice.id)).toEqual([
            '/model',
            '/model pick',
            '/model list',
            '/resume',
            '/approval safe',
        ]);

        const downState = reduceSlashCommandMenuSelection(initialState, '\u001b[B', '/mo');
        const upState = reduceSlashCommandMenuSelection(downState, '\u001b[A', '/mo');

        expect(createSlashCommandMenuView('/mo', downState, 5).selectedIndex).toBe(1);
        expect(createSlashCommandMenuView('/mo', upState, 5).selectedIndex).toBe(0);
        expect(resolveSlashCommandMenuSubmission('/mo', upState)).toBe('/model');
    });

    it('selects slash commands with CSI arrow press and repeat reports while ignoring releases', () => {
        const initialState = createSlashCommandMenuState();
        const downState = reduceSlashCommandMenuSelection(initialState, '\u001b[1;1B', '/mo');
        const releaseState = reduceSlashCommandMenuSelection(downState, '\u001b[1;1:3B', '/mo');
        const repeatState = reduceSlashCommandMenuSelection(releaseState, '\u001b[1;1:2B', '/mo');

        expect(createSlashCommandMenuView('/mo', downState, 5).selectedIndex).toBe(1);
        expect(createSlashCommandMenuView('/mo', releaseState, 5).selectedIndex).toBe(1);
        expect(createSlashCommandMenuView('/mo', repeatState, 5).selectedIndex).toBe(2);
    });

    it('shows an empty state for unmatched slash command searches without rewriting submission', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/zz', state, 5);

        expect(view.open).toBe(true);
        expect(view.empty).toBe(true);
        expect(view.visibleChoices).toEqual([]);
        expect(resolveSlashCommandMenuSubmission('/zz', state)).toBe('/zz');
    });

    it('includes session navigation commands in the slash menu', () => {
        const view = createSlashCommandMenuView('/s', createSlashCommandMenuState(), 20);

        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(
            expect.arrayContaining(['/session', '/sessions']),
        );
        expect(createSlashCommandMenuView('/tr', createSlashCommandMenuState(), 20).visibleChoices).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: '/tree' })]),
        );
    });

    it('formats a terminal input block with a menu above a styled prompt', () => {
        const block = formatTerminalChatInputBlock('/mo', createSlashCommandMenuState(), 100);

        expect(block).toContain('/model');
        expect(block).toContain('Commands');
        expect(block).toContain('\u001b[48;5;236m> /mo');
    });

    it('formats the typing area as a three-line highlighted input surface', () => {
        const block = formatTerminalChatInputBlock('hello', createSlashCommandMenuState(), 40);
        const highlightedLines = block.split('\n').filter((line) => line.includes('\u001b[48;5;236m'));

        expect(highlightedLines).toHaveLength(3);
        expect(highlightedLines[0]?.replaceAll('\u001b[48;5;236m', '')).toContain(' ');
        expect(highlightedLines[1]).toContain('> hello');
        expect(highlightedLines[2]?.replaceAll('\u001b[48;5;236m', '')).toContain(' ');
        expect(block).toContain('\u001b[1A\r\u001b[7C');
    });

    it('formats committed input as a plain history line without the transient menu', () => {
        const committedLine = formatTerminalChatCommittedInputLine('/model', 100);

        expect(committedLine).toBe('> /model');
        expect(committedLine).not.toContain('Commands');
        expect(committedLine).not.toContain('\u001b[48;5;236m');
    });

    it('formats a multiline input surface with model status below the editor', () => {
        const block = formatTerminalChatInputBlock('hello\nworld', createSlashCommandMenuState(), 60, {
            providerID: 'local',
            modelID: 'local-echo',
        });
        const highlightedLines = block.split('\n').filter((line) => line.includes('\u001b[48;5;236m'));

        expect(highlightedLines).toHaveLength(4);
        expect(block).toContain('> hello');
        expect(block).toContain('  world');
        expect(block).not.toContain('| world');
        expect(block).toContain('Local Echo(Default)');
        expect(block).toContain('Local Sandbox');
        expect(block).toContain('\u001b[2mLocal Sandbox\u001b[0m');
        expect(block).toContain('\u001b[2A\r\u001b[7C');
    });

    it('formats unknown status variants without dropping the selected variant id', () => {
        const block = formatTerminalChatInputBlock('', createSlashCommandMenuState(), 60, {
            providerID: 'custom-provider',
            modelID: 'custom-model',
            variantID: 'thinking',
        });

        expect(block).toContain('custom-model(thinking)');
        expect(block).toContain('custom-provider');
    });

    it('formats newline-created empty input lines with whitespace fill', () => {
        const block = renderTerminalChatInputBlock('hello\n', createSlashCommandMenuState(), 60);
        const highlightedLines = block.text.split('\n').filter((line) => line.includes('\u001b[48;5;236m'));
        const emptyContinuationLine = highlightedLines[2] ?? '';

        expect(block.text).toContain('> hello');
        expect(emptyContinuationLine).not.toContain('|');
        expect(emptyContinuationLine.replaceAll('\u001b[48;5;236m', '')).toContain('   ');
        expect(block.cursorLineIndex).toBe(2);
        expect(block.text).toContain('\u001b[1A\r\u001b[2C');
    });

    it('formats committed multiline input as plain history without model status', () => {
        const committedLine = formatTerminalChatCommittedInputLine('hello\nworld', 100);

        expect(committedLine).toBe('> hello\n  world');
        expect(committedLine).not.toContain('provider:');
        expect(committedLine).not.toContain('\u001b[48;5;236m');
    });

    it('inserts multiline text at the active cursor and renders the cursor on that line', () => {
        const firstLine = insertTerminalChatInputText({ value: '', cursorOffset: 0 }, 'hello');
        const multiline = insertTerminalChatInputText(firstLine, '\nworld');
        const moved = moveTerminalChatInputCursor(moveTerminalChatInputCursor(multiline, 'left'), 'left');
        const edited = insertTerminalChatInputText(moved, '!');
        const block = renderTerminalChatInputBlock(edited, createSlashCommandMenuState(), 60);

        expect(edited.value).toBe('hello\nwor!ld');
        expect(edited.cursorOffset).toBe(10);
        expect(block.cursorLineIndex).toBe(2);
        expect(block.text).toContain('  wor!ld');
        expect(block.text).not.toContain('| wor!ld');
        expect(block.text).toContain('\u001b[1A\r\u001b[6C');
    });

    it('moves and deletes by grapheme when editing Korean and emoji input', () => {
        const initial = insertTerminalChatInputText({ value: '', cursorOffset: 0 }, '한글🙂');
        const moved = moveTerminalChatInputCursor(initial, 'left');
        const edited = insertTerminalChatInputText(moved, '!');
        const deletedEmoji = deleteTerminalChatInputCharacterBeforeCursor(initial);
        const deletedKorean = deleteTerminalChatInputCharacterBeforeCursor(deletedEmoji);

        expect(initial.cursorOffset).toBe('한글🙂'.length);
        expect(moved.cursorOffset).toBe('한글'.length);
        expect(edited.value).toBe('한글!🙂');
        expect(deletedEmoji).toEqual({ value: '한글', cursorOffset: '한글'.length });
        expect(deletedKorean).toEqual({ value: '한', cursorOffset: '한'.length });
    });

    it('renders cursor columns and padding with terminal display width', () => {
        const block = formatTerminalChatInputBlock('한국어', createSlashCommandMenuState(), 20);
        const highlightedLines = block.split('\n').filter((line) => line.includes('\u001b[48;5;236m'));

        expect(highlightedLines[1]).toContain('> 한국어');
        expect(block).toContain('\u001b[1A\r\u001b[8C');
    });

    it('keeps vertical cursor movement aligned by display columns for CJK text', () => {
        const input = insertTerminalChatInputText({ value: '', cursorOffset: 0 }, '한국어\nab');
        const movedUp = moveTerminalChatInputCursor(input, 'up');
        const block = renderTerminalChatInputBlock(movedUp, createSlashCommandMenuState(), 40);

        expect(movedUp.cursorOffset).toBe('한'.length);
        expect(block.text).toContain('\u001b[2A\r\u001b[4C');
    });

    it('moves by editor navigation keys across lines and words', () => {
        const value = 'alpha beta\nsecond line\nthird';
        const insideSecondLine = { value, cursorOffset: 'alpha beta\nsec'.length };
        const atBeta = { value: 'alpha beta gamma', cursorOffset: 'alpha beta gamma'.length };

        expect(moveTerminalChatInputCursor(insideSecondLine, 'line-start').cursorOffset).toBe('alpha beta\n'.length);
        expect(moveTerminalChatInputCursor(insideSecondLine, 'line-end').cursorOffset).toBe(
            'alpha beta\nsecond line'.length,
        );
        expect(moveTerminalChatInputCursor(insideSecondLine, 'input-start').cursorOffset).toBe(0);
        expect(moveTerminalChatInputCursor(insideSecondLine, 'input-end').cursorOffset).toBe(value.length);
        expect(moveTerminalChatInputCursor(atBeta, 'word-left').cursorOffset).toBe('alpha beta '.length);
        expect(
            moveTerminalChatInputCursor(moveTerminalChatInputCursor(atBeta, 'word-left'), 'word-left').cursorOffset,
        ).toBe('alpha '.length);
        expect(moveTerminalChatInputCursor({ value: atBeta.value, cursorOffset: 0 }, 'word-right').cursorOffset).toBe(
            'alpha '.length,
        );
        expect(
            moveTerminalChatInputCursor({ value: atBeta.value, cursorOffset: 'alpha be'.length }, 'word-right')
                .cursorOffset,
        ).toBe('alpha beta '.length);
    });

    it('recognizes terminal Shift+Enter sequences without treating their trailing return as submit', () => {
        const mode = { modifiedKeysEnabled: true };

        expect(isTerminalShiftEnterSequence('\u001b[13;2u', mode)).toBe(true);
        expect(isTerminalShiftEnterSequence('\u001b[13;2u\r', mode)).toBe(true);
        expect(isTerminalShiftEnterSequence('\u001b[27;2;13~', mode)).toBe(true);
        expect(isTerminalShiftEnterSequence('\u001b\r', mode)).toBe(true);
        expect(isTerminalShiftEnterSequence('\n', mode)).toBe(true);
        expect(isTerminalShiftEnterSequence('\r', mode)).toBe(false);
    });

    it('deletes wrapped Korean graphemes without moving the cursor into a fullwidth cell', () => {
        const input = insertTerminalChatInputText({ value: '', cursorOffset: 0 }, '\ud55c\uad6d\uc5b4');
        const movedLeft = moveTerminalChatInputCursor(input, 'left');
        const deleted = deleteTerminalChatInputCharacterBeforeCursor(movedLeft);
        const block = renderTerminalChatInputBlock(deleted, createSlashCommandMenuState(), 12);

        expect(deleted.value).toBe('\ud55c\uc5b4');
        expect(deleted.cursorOffset).toBe(1);
        expect(block.text).toContain('\u001b[4C');
    });

    it('renders cursor after deleting CJK text at a wrap boundary', () => {
        const input = insertTerminalChatInputText({ value: '', cursorOffset: 0 }, '\ud55c\uad6d\uc5b4\n\uc548\ub155');
        const atSecondLineStart = moveTerminalChatInputCursor(input, 'line-start');
        const deleted = deleteTerminalChatInputCharacterBeforeCursor(atSecondLineStart);
        const block = renderTerminalChatInputBlock(deleted, createSlashCommandMenuState(), 20);

        expect(deleted.value).toBe('\ud55c\uad6d\uc5b4\uc548\ub155');
        expect(deleted.cursorOffset).toBe(3);
        expect(block.text).toContain('\u001b[8C');
    });

    it('emits terminal modified-key protocol toggles for distinguishing Shift+Enter from Enter', () => {
        expect(terminalModifiedKeyEnableSequence).toContain('\u001b[>7u');
        expect(terminalModifiedKeyEnableSequence).toContain('\u001b[>4;2m');
        expect(terminalModifiedKeyDisableSequence).toContain('\u001b[<u');
        expect(terminalModifiedKeyDisableSequence).toContain('\u001b[>4;0m');
    });

    it('returns the untrimmed workflow insertText (with trailing space) for the selected choice', () => {
        const workflows = ['default', 'planner', 'runner'];
        const initial = createSlashCommandMenuState();

        expect(resolveWorkflowCommandMenuInsertText('#', initial, workflows)).toBe('#default ');

        const down = reduceWorkflowCommandMenuSelection(initial, '\u001b[B', '#', workflows);
        expect(resolveWorkflowCommandMenuInsertText('#', down, workflows)).toBe('#planner ');

        const downAgain = reduceWorkflowCommandMenuSelection(down, '\u001b[B', '#', workflows);
        expect(resolveWorkflowCommandMenuInsertText('#', downAgain, workflows)).toBe('#runner ');
    });

    it('returns undefined when the workflow menu is closed or has no selection', () => {
        expect(resolveWorkflowCommandMenuInsertText('#planner ', createSlashCommandMenuState(), ['planner'])).toBeUndefined();
        expect(resolveWorkflowCommandMenuInsertText('plain', createSlashCommandMenuState(), ['planner'])).toBeUndefined();
        expect(resolveWorkflowCommandMenuInsertText('#zzz', createSlashCommandMenuState(), ['planner'])).toBeUndefined();
    });

    it('reports the slash menu open only while the command token has no whitespace', () => {
        expect(isSlashCommandMenuOpen('/')).toBe(true);
        expect(isSlashCommandMenuOpen('/mod')).toBe(true);
        expect(isSlashCommandMenuOpen('/exit')).toBe(true);

        expect(isSlashCommandMenuOpen('/new ')).toBe(false);
        expect(isSlashCommandMenuOpen('/model pick')).toBe(false);
        expect(isSlashCommandMenuOpen('/approval\n')).toBe(false);
        expect(isSlashCommandMenuOpen('/cmd\t')).toBe(false);
        expect(isSlashCommandMenuOpen('plain text')).toBe(false);
    });

    it('reports the workflow menu open only while the command token has no whitespace', () => {
        expect(isWorkflowCommandMenuOpen('#')).toBe(true);
        expect(isWorkflowCommandMenuOpen('#default')).toBe(true);
        expect(isWorkflowCommandMenuOpen('#planner ')).toBe(false);
        expect(isWorkflowCommandMenuOpen('plain')).toBe(false);
    });

    it('marks /approval, /model, and /model pick as opening a secondary picker', () => {
        const find = (id: string): SlashCommandMenuChoice | undefined =>
            slashCommandChoices.find((c) => c.id === id);
        expect(find('/approval')?.opensPicker).toBe(true);
        expect(find('/model')?.opensPicker).toBe(true);
        expect(find('/model pick')?.opensPicker).toBe(true);
    });

    it('does not mark plain commands as opening a picker', () => {
        const find = (id: string): SlashCommandMenuChoice | undefined =>
            slashCommandChoices.find((c) => c.id === id);
        expect(find('/exit')?.opensPicker).not.toBe(true);
        expect(find('/help')?.opensPicker).not.toBe(true);
        expect(find('/sessions')?.opensPicker).not.toBe(true);
    });

    it('surfaces the opensPicker flag through the slash menu view', () => {
        const view = createSlashCommandMenuView('/approval', createSlashCommandMenuState(), 10);
        const approval = view.visibleChoices.find((c) => c.id === '/approval');
        expect(approval?.opensPicker).toBe(true);
    });
});
