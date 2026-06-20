import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import { createInkChatBridgeCore, replaceCoreOutputText } from './ink-chat-bridge.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    resolveSlashCommandMenuSubmission,
} from './interactive-chat-command-menu.js';
import {
    runRedoAction,
    runUndoAction,
    type UndoRedoConversationController,
} from './interactive-chat-undo-redo-action.js';
import {
    createUndoRedoStack,
    extractLastMessagePair,
    formatMessagePair,
    isEmpty,
    type MessagePair,
    popUndonePair,
    pushUndonePair,
} from './interactive-chat-undo-redo-stack.js';

const SAMPLE_PAIR_A: MessagePair = { userText: 'hello', assistantText: 'hi there' };
const SAMPLE_PAIR_B: MessagePair = { userText: 'second question', assistantText: 'second answer' };
const SAMPLE_PAIR_C: MessagePair = { userText: 'third prompt', assistantText: 'third response' };

describe('undo/redo stack state machine', () => {
    it('reports an empty stack as empty', () => {
        const stack = createUndoRedoStack();
        expect(isEmpty(stack)).toBe(true);
        expect(stack.undonePairs).toEqual([]);
    });

    it('stores a pushed pair and becomes non-empty', () => {
        const stack = pushUndonePair(createUndoRedoStack(), SAMPLE_PAIR_A);
        expect(isEmpty(stack)).toBe(false);
        expect(stack.undonePairs).toHaveLength(1);
        expect(stack.undonePairs[0]).toEqual(SAMPLE_PAIR_A);
    });

    it('returns the only pair and empties the stack on pop', () => {
        const stack = pushUndonePair(createUndoRedoStack(), SAMPLE_PAIR_A);
        const result = popUndonePair(stack);
        expect(result.pair).toEqual(SAMPLE_PAIR_A);
        expect(isEmpty(result.stack)).toBe(true);
    });

    it('returns undefined and an unchanged stack when popping an empty stack', () => {
        const stack = createUndoRedoStack();
        const result = popUndonePair(stack);
        expect(result.pair).toBeUndefined();
        expect(result.stack).toBe(stack);
        expect(isEmpty(result.stack)).toBe(true);
    });

    it('honors LIFO order when pushing three pairs and popping once', () => {
        let stack = createUndoRedoStack();
        stack = pushUndonePair(stack, SAMPLE_PAIR_A);
        stack = pushUndonePair(stack, SAMPLE_PAIR_B);
        stack = pushUndonePair(stack, SAMPLE_PAIR_C);
        expect(stack.undonePairs).toHaveLength(3);

        const result = popUndonePair(stack);
        expect(result.pair).toEqual(SAMPLE_PAIR_C);
        expect(result.stack.undonePairs).toHaveLength(2);
    });

    it('exhausts the stack after three pops and returns undefined on the fourth', () => {
        let stack = createUndoRedoStack();
        stack = pushUndonePair(stack, SAMPLE_PAIR_A);
        stack = pushUndonePair(stack, SAMPLE_PAIR_B);
        stack = pushUndonePair(stack, SAMPLE_PAIR_C);

        const first = popUndonePair(stack);
        const second = popUndonePair(first.stack);
        const third = popUndonePair(second.stack);
        const fourth = popUndonePair(third.stack);

        expect(first.pair).toEqual(SAMPLE_PAIR_C);
        expect(second.pair).toEqual(SAMPLE_PAIR_B);
        expect(third.pair).toEqual(SAMPLE_PAIR_A);
        expect(fourth.pair).toBeUndefined();
        expect(isEmpty(fourth.stack)).toBe(true);
    });

    it('does not mutate the original stack on push (immutability)', () => {
        const original = createUndoRedoStack();
        const next = pushUndonePair(original, SAMPLE_PAIR_A);

        expect(original.undonePairs).toEqual([]);
        expect(isEmpty(original)).toBe(true);
        expect(next.undonePairs).toHaveLength(1);
        expect(next).not.toBe(original);
    });
});

describe('extractLastMessagePair', () => {
    it('returns undefined for empty text', () => {
        expect(extractLastMessagePair('')).toBeUndefined();
    });

    it('returns undefined when there is no You:/Assistant: pair', () => {
        expect(extractLastMessagePair('system message\nanother line\n')).toBeUndefined();
        expect(extractLastMessagePair('You: only user\n')).toBeUndefined();
        expect(extractLastMessagePair('Assistant: only assistant\n')).toBeUndefined();
    });

    it('extracts the last pair and returns the remaining text', () => {
        const text = 'mission-control chat\nYou: hello\nAssistant: hi there\n';
        const result = extractLastMessagePair(text);
        expect(result).toBeDefined();
        expect(result?.pair).toEqual(SAMPLE_PAIR_A);
        expect(result?.remaining).toBe('mission-control chat\n');
    });

    it('finds the last pair among multiple', () => {
        const text = 'You: first\nAssistant: first answer\nYou: second question\nAssistant: second answer\n';
        const result = extractLastMessagePair(text);
        expect(result?.pair).toEqual(SAMPLE_PAIR_B);
        expect(result?.remaining).toBe('You: first\nAssistant: first answer\n');
    });

    it('skips interleaved system and error lines', () => {
        const text = 'You: q\nAssistant: a\nsystem note\nYou: q2\nAssistant: a2\nError: boom\n';
        const result = extractLastMessagePair(text);
        expect(result?.pair).toEqual({ userText: 'q2', assistantText: 'a2' });
    });
});

describe('formatMessagePair', () => {
    it('formats a pair as You:/Assistant: lines', () => {
        expect(formatMessagePair(SAMPLE_PAIR_A)).toBe('You: hello\nAssistant: hi there\n');
    });
});

describe('undo/redo command parser', () => {
    it('parses /undo as a no-argument undo action', () => {
        expect(parseChatLine('/undo')).toEqual({ kind: 'undo' });
    });

    it('parses /redo as a no-argument redo action', () => {
        expect(parseChatLine('/redo')).toEqual({ kind: 'redo' });
    });

    it('rejects /undo with extra arguments', () => {
        expect(parseChatLine('/undo extra')).toEqual({
            kind: 'invalid',
            message: '/undo does not accept arguments',
        });
    });

    it('rejects /redo with extra arguments', () => {
        expect(parseChatLine('/redo extra')).toEqual({
            kind: 'invalid',
            message: '/redo does not accept arguments',
        });
    });
});

describe('undo/redo slash command menu', () => {
    it('filters /und down to /undo', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/und', state, 20);
        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(['/undo']);
    });

    it('filters /red down to /redo', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/red', state, 20);
        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(['/redo']);
    });

    it('resolves /und submission to /undo', () => {
        expect(resolveSlashCommandMenuSubmission('/und', createSlashCommandMenuState())).toBe('/undo');
    });

    it('resolves /red submission to /redo', () => {
        expect(resolveSlashCommandMenuSubmission('/red', createSlashCommandMenuState())).toBe('/redo');
    });
});

describe('undo action handler', () => {
    it('writes Nothing to undo when output has no pair', async () => {
        const output = createCapturingOutput();
        const controller = createController('');

        await runUndoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);

        expect(output.text()).toContain('Nothing to undo.');
        expect(isEmpty(controller.getStack())).toBe(true);
    });

    it('removes the last pair from the conversation text and pushes it to the stack', async () => {
        const output = createCapturingOutput();
        const controller = createController('intro\nYou: hello\nAssistant: hi there\n');

        await runUndoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);

        expect(controller.getStack().undonePairs).toEqual([SAMPLE_PAIR_A]);
        expect(controller.readOutputText()).not.toContain('You: hello');
        expect(controller.readOutputText()).not.toContain('Assistant: hi there');
    });

    it('reports unavailability when the controller is undefined', async () => {
        const output = createCapturingOutput();
        await runUndoAction(output, { providerID: 'local', modelID: 'local-echo' }, undefined, undefined);
        expect(output.text()).toContain('Undo unavailable');
    });

    it('does not write to the durable session store', async () => {
        const output = createCapturingOutput();
        const controller = createController('You: q\nAssistant: a\n');
        const result = await runUndoAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            controller,
            undefined,
        );
        // The action result must NOT carry a sessionStore or sessionId mutation.
        expect(result.sessionStore).toBeUndefined();
    });
});

describe('redo action handler', () => {
    it('writes Nothing to redo when the stack is empty', async () => {
        const output = createCapturingOutput();
        const controller = createController('');

        await runRedoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);

        expect(output.text()).toContain('Nothing to redo.');
    });

    it('restores a previously undone pair from the stack', async () => {
        const output = createCapturingOutput();
        const controller = createController('intro\n');
        controller.setStack(pushUndonePair(createUndoRedoStack(), SAMPLE_PAIR_A));

        await runRedoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);

        expect(isEmpty(controller.getStack())).toBe(true);
        expect(controller.readOutputText()).toContain('You: hello');
        expect(controller.readOutputText()).toContain('Assistant: hi there');
    });

    it('reports unavailability when the controller is undefined', async () => {
        const output = createCapturingOutput();
        await runRedoAction(output, { providerID: 'local', modelID: 'local-echo' }, undefined, undefined);
        expect(output.text()).toContain('Redo unavailable');
    });

    it('does not write to the durable session store', async () => {
        const output = createCapturingOutput();
        const controller = createController('');
        const result = await runRedoAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            controller,
            undefined,
        );
        expect(result.sessionStore).toBeUndefined();
    });
});

describe('undo then redo round-trip', () => {
    it('removes a pair via undo then restores it via redo', async () => {
        const output = createCapturingOutput();
        const controller = createController('intro\nYou: hello\nAssistant: hi there\n');

        await runUndoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);
        expect(controller.readOutputText()).not.toContain('You: hello');

        await runRedoAction(output, { providerID: 'local', modelID: 'local-echo' }, controller, undefined);
        expect(controller.readOutputText()).toContain('You: hello');
        expect(controller.readOutputText()).toContain('Assistant: hi there');
        expect(isEmpty(controller.getStack())).toBe(true);
    });
});

describe('bridge replaceCoreOutputText', () => {
    it('replaces core.outputText entirely', () => {
        const core = createInkChatBridgeCore();
        core.outputText = 'line1\nline2\n';

        replaceCoreOutputText(core, 'replaced\n');

        expect(core.outputText).toBe('replaced\n');
    });

    it('publishes a fresh snapshot reflecting the new text', () => {
        const core = createInkChatBridgeCore();
        core.outputText = 'original\n';
        const before = core.snapshot;

        replaceCoreOutputText(core, 'truncated\n');

        expect(core.snapshot.outputText).toBe('truncated\n');
        expect(core.snapshot).not.toBe(before);
    });

    it('emits then replace simulates the /undo display flow', () => {
        const core = createInkChatBridgeCore();
        core.outputText += 'intro\n';
        core.outputText += 'You: hello\n';
        core.outputText += 'Assistant: hi\n';

        replaceCoreOutputText(core, 'intro\n');

        expect(core.outputText).toBe('intro\n');
        expect(core.outputText).not.toContain('You: hello');
    });
});

type CapturingOutput = {
    readonly write: (text: string) => void;
    readonly text: () => string;
};

function createCapturingOutput(): CapturingOutput {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        text: () => chunks.join(''),
    };
}

function createController(initialText: string): UndoRedoConversationController {
    let text = initialText;
    let stack = createUndoRedoStack();
    return {
        readOutputText: () => text,
        replaceOutputText: (next: string) => {
            text = next;
        },
        getStack: () => stack,
        setStack: (next) => {
            stack = next;
        },
    };
}
