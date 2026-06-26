/**
 * Regression tests for the slash/workflow menu open-state check in
 * `bridgeTextareaKeyDown`. The handler previously used
 * `buffer.startsWith('/')` / `buffer.startsWith('#')` to decide whether to
 * hijack Up/Down for menu navigation, but the actual menu closes once the
 * command token contains whitespace (per `readCommandQuery`). The fix routes
 * through `isSlashCommandMenuOpen` / `isWorkflowCommandMenuOpen` so arrows
 * flow to history recall once the user types past the command token.
 */
import { describe, expect, it } from 'vitest';
import { bridgeTextareaKeyDown, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

describe('opentui bridge command menu arrow behavior', () => {
    it('recalls history on Up after the slash menu closes from a trailing space', () => {
        const core = createOpenTuiChatBridgeCore({
            initialHistoryEntries: ['previous prompt'],
        });
        const textarea = createRecordingTextarea('/new ', 0);
        const textareaRef = asTextareaRef(textarea);
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);

        expect(textarea.setTextCalls).toContain('previous prompt');
    });

    it('recalls history on Up after the workflow menu closes from a trailing space', () => {
        const core = createOpenTuiChatBridgeCore({
            initialHistoryEntries: ['#default older prompt'],
        });
        const textarea = createRecordingTextarea('#default ', 0);
        const textareaRef = asTextareaRef(textarea);
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);

        expect(textarea.setTextCalls).toContain('#default older prompt');
    });

    it('navigates the slash menu on Down while the menu is open', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('/mod', 4);
        const textareaRef = asTextareaRef(textarea);
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);

        expect(core.menuState.selectedIndex).toBe(1);
        expect(textarea.setTextCalls).toEqual([]);
    });

    it('does not hijack Down for menu nav after the slash token has a space', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('/model pick', 11);
        const textareaRef = asTextareaRef(textarea);
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);

        expect(core.menuState.selectedIndex).toBe(0);
    });
});
