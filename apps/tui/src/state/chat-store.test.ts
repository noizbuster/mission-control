import { extractUsageFromModelCallCompleted } from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderPromptKeypressState } from './auth-provider-keypress.js';
import type { ChatInputEvent } from './chat-input-event.js';
import {
    type AgentsDashboardState,
    type ChatStore,
    createAgentsDashboardView,
    createChatStore,
    createSessionPickerView,
    type DashboardAgentEntry,
    type MissionPanelRow,
    type MissionPanelTab,
    type SessionPickerEntry,
} from './chat-store.js';
import type { ModelChoice } from './interactive-chat-model.js';

function makeSelection(providerID: string, modelID: string): ModelProviderSelection {
    return { providerID, modelID };
}

function makeChoice(id: string, selection?: ModelProviderSelection): ModelChoice {
    return {
        id,
        label: id,
        selection: selection ?? makeSelection('test', id),
        capabilityStatus: 'executable',
        availableForCoding: true,
    };
}

function makeLineEvent(value: string): ChatInputEvent {
    return { type: 'line', value };
}

function makeSessionEntry(sessionId: string, label?: string): SessionPickerEntry {
    return {
        sessionId,
        label: label ?? sessionId,
        messageCount: 0,
        status: 'idle',
    };
}

describe('chat-store — subscribe / getSnapshot', () => {
    it('returns the initial state from getSnapshot', () => {
        const store = createChatStore();
        const snapshot = store.getSnapshot();
        expect(snapshot.outputText).toBe('');
        expect(snapshot.inputMirror).toBe('');
        expect(snapshot.generating).toBe(false);
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.historyNavigation).toBeNull();
    });

    it('subscribe registers a listener that fires on publish', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.setGenerating(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('subscribe returns an unsubscribe function', () => {
        const store = createChatStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.setGenerating(true);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.setGenerating(false);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('chat-store — emitOutput', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('appends text and fires the listener after the coalesce window', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('hello');
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().outputText).toBe('hello');
        expect(store.getOutput()).toBe('hello');
    });

    it('coalesces 100 rapid calls into a single notification', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        for (let i = 0; i < 100; i++) {
            store.emitOutput('x');
        }
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('x'.repeat(100));
    });

    it('produces separate notifications across distinct coalesce windows', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('a');
        vi.advanceTimersByTime(20);
        store.emitOutput('b');
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getOutput()).toBe('ab');
    });

    it('coalesces rapid calls at the 50ms window while generating=true (not 16ms)', () => {
        const store = createChatStore();
        store.setGenerating(true);
        const listener = vi.fn();
        store.subscribe(listener);
        for (let i = 0; i < 50; i++) {
            store.emitOutput('x');
        }
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(16);
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(34);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('x'.repeat(50));
    });

    it('coalesces rapid calls at the 16ms window while generating=false (idle)', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('a');
        vi.advanceTimersByTime(15);
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('a');
    });
});

describe('chat-store — replaceOutputText / getOutput', () => {
    it('replaceOutputText replaces the full text and publishes immediately', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('old');
        store.replaceOutputText('new');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('new');
        expect(store.getSnapshot().outputText).toBe('new');
    });

    it('getOutput returns the current accumulated text', () => {
        const store = createChatStore();
        store.replaceOutputText('line1\n');
        store.replaceOutputText('line2');
        expect(store.getOutput()).toBe('line2');
    });
});

describe('chat-store — model picker overlay', () => {
    it('showModelPicker sets overlay and hideModelPicker resolves the promise', async () => {
        const store = createChatStore();
        const choices = [makeChoice('a'), makeChoice('b')];
        const promise = store.showModelPicker(choices);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        expect(store.getSnapshot().modelPickerChoices).toEqual(choices);
        const selection = makeSelection('test', 'a');
        store.hideModelPicker(selection);
        const result = await promise;
        expect(result).toEqual(selection);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showModelPicker with empty choices resolves undefined without opening overlay', async () => {
        const store = createChatStore();
        const result = await store.showModelPicker([]);
        expect(result).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('hideModelPicker with no selection resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showModelPicker([makeChoice('a')]);
        store.hideModelPicker();
        expect(await promise).toBeUndefined();
    });
});

describe('chat-store — level picker overlay', () => {
    it('showLevelPicker sets selectedIndex based on currentLevel', () => {
        const store = createChatStore();
        store.showLevelPicker('aggressive');
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('level-picker');
        expect(snapshot.levelPickerSelectedIndex).toBe(2);
    });

    it('showLevelPicker defaults to index 1 (safe) when currentLevel is unknown', () => {
        const store = createChatStore();
        store.showLevelPicker('nonexistent');
        expect(store.getSnapshot().levelPickerSelectedIndex).toBe(1);
    });

    it('hideLevelPicker resolves the promise and resets overlay', async () => {
        const store = createChatStore();
        const promise = store.showLevelPicker('safe');
        store.hideLevelPicker('aggressive');
        expect(await promise).toBe('aggressive');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — approval overlay', () => {
    it('showApproval sets overlay fields and hideApproval resets', () => {
        const store = createChatStore();
        store.showApproval('file.edit', 'edit src.ts');
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('approval');
        expect(snapshot.approvalToolName).toBe('file.edit');
        expect(snapshot.approvalAction).toBe('edit src.ts');
        expect(snapshot.approvalSelectedIndex).toBe(0);
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — question overlay', () => {
    it('showQuestion sets overlay and resolveQuestion resolves the promise', async () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no'], { header: 'Confirm' });
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('question');
        expect(snapshot.questionText).toBe('Continue?');
        expect(snapshot.questionHeader).toBe('Confirm');
        expect(snapshot.questionOptions).toHaveLength(2);
        expect(snapshot.questionMultiple).toBe(false);
        store.resolveQuestion('yes');
        expect(await promise).toBe('yes');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showQuestion with multiple flag initializes multi-select state', () => {
        const store = createChatStore();
        store.showQuestion('Pick', ['a', 'b'], { multiple: true });
        const snapshot = store.getSnapshot();
        expect(snapshot.questionMultiple).toBe(true);
        expect(snapshot.questionSelectedIndices).toEqual(new Set<number>());
    });

    it('selectQuestionByClick resolves single-select immediately with the clicked label', async () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no']);
        store.selectQuestionByClick(1);
        expect(await promise).toBe('no');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('selectQuestionByClick toggles membership in multi-select without resolving', () => {
        const store = createChatStore();
        store.showQuestion('Pick', ['a', 'b'], { multiple: true });
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>([0]));
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>());
        expect(store.getSnapshot().overlayMode).toBe('question');
    });

    it('selectQuestionByClick on the custom-answer row index enters custom mode', () => {
        const store = createChatStore();
        store.showQuestion('Continue?', ['yes', 'no']);
        store.selectQuestionByClick(2);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionCustomMode).toBe(true);
        expect(snapshot.questionSelectedIndex).toBe(2);
        expect(snapshot.questionCustomBuffer).toBe('');
    });

    it('hoverQuestion moves the cursor without resolving (single-select)', () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no']);
        store.hoverQuestion(1);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionSelectedIndex).toBe(1);
        expect(snapshot.overlayMode).toBe('question');
        store.resolveQuestion('');
        return promise;
    });

    it('hoverQuestion reaches the custom-answer row and is a no-op when already active', () => {
        const store = createChatStore();
        store.showQuestion('Continue?', ['yes', 'no']);
        store.hoverQuestion(2);
        expect(store.getSnapshot().questionSelectedIndex).toBe(2);
        expect(store.getSnapshot().questionCustomMode).toBe(false);
        store.hoverQuestion(2);
        expect(store.getSnapshot().questionSelectedIndex).toBe(2);
    });

    it('hoverQuestion is a no-op when no question overlay is open', () => {
        const store = createChatStore();
        store.hoverQuestion(0);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — multi-question batch', () => {
    it('showQuestionBatch opens a tabbed overlay with a confirm tab for N>1', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'Lang?', header: 'Language', options: [{ label: 'TS' }, { label: 'Go' }], multiple: false },
            {
                question: 'Level?',
                header: 'Level',
                options: [{ label: 'Junior' }, { label: 'Senior' }],
                multiple: false,
            },
        ]);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('question');
        expect(snapshot.questionTabs).toHaveLength(2);
        expect(snapshot.questionConfirmActive).toBe(false);
        expect(snapshot.questionText).toBe('Lang?');
    });

    it('a single-select pick advances to the next tab, then confirm submits all answers', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            { question: 'Lang?', header: 'Language', options: [{ label: 'TS' }, { label: 'Go' }], multiple: false },
            {
                question: 'Level?',
                header: 'Level',
                options: [{ label: 'Junior' }, { label: 'Senior' }],
                multiple: false,
            },
        ]);
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionTabIndex).toBe(1);
        store.selectQuestionByClick(1);
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
        store.confirmQuestionBatch();
        expect(await promise).toEqual(['TS', 'Senior']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('Left/Right tab navigation wraps across questions + confirm and preserves answers', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }], multiple: false },
        ]);
        store.selectQuestionByClick(1);
        store.navigateQuestionTab(-1); // back to tab 0
        expect(store.getSnapshot().questionTabIndex).toBe(0);
        expect(store.getSnapshot().questionConfirmActive).toBe(false);
        store.navigateQuestionTab(-1); // wrap back from 0 → confirm tab
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
    });

    it('multi-select toggles membership and only resolves at confirm', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            {
                question: 'Toppings?',
                header: 'Toppings',
                options: [{ label: 'cheese' }, { label: 'mushroom' }, { label: 'olive' }],
                multiple: true,
            },
        ]);
        // single multiple-select question → multi batch (has confirm tab)
        expect(store.getSnapshot().questionConfirmActive).toBe(false);
        store.navigateQuestion(1);
        store.toggleQuestionOption();
        store.navigateQuestion(1);
        store.toggleQuestionOption();
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>([1, 2]));
        store.navigateQuestionTab(1); // to confirm tab
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
        store.confirmQuestionBatch();
        expect(await promise).toEqual(['mushroom, olive']);
    });

    it('rejectQuestion cancels the whole batch with empty answers', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }], multiple: false },
        ]);
        store.selectQuestionByClick(0);
        store.rejectQuestion();
        expect(await promise).toEqual(['', '']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showQuestion (single) resets batch state so no tabs render', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }], multiple: false },
        ]);
        store.showQuestion('Plain?', ['x', 'y']);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionTabs).toHaveLength(0);
        expect(snapshot.questionConfirmActive).toBe(false);
        expect(snapshot.questionText).toBe('Plain?');
    });
});

describe('chat-store — rename overlay', () => {
    it('showRename sets overlay and submitRename fires callback', () => {
        const store = createChatStore();
        const submitted: string[] = [];
        store.onRenameSubmit = (name) => {
            submitted.push(name);
        };
        store.showRename();
        expect(store.getSnapshot().overlayMode).toBe('rename');
        store.submitRename('my-session');
        expect(submitted).toEqual(['my-session']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showRename pre-fills the buffer with the session display name when set', () => {
        const store = createChatStore();
        store.setSessionId('session_abc');
        store.setSessionDisplayName('investigating bug');

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('investigating bug');
    });

    it('showRename falls back to the session id when no display name is set', () => {
        const store = createChatStore();
        store.setSessionId('session_abc');

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('session_abc');
    });

    it('showRename leaves the buffer empty when neither display name nor session id is set', () => {
        const store = createChatStore();

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('');
    });

    it('setSessionDisplayName is a no-op publish when the value is unchanged', () => {
        const store = createChatStore();
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.setSessionDisplayName('first');
        const afterFirst = publishCount;
        store.setSessionDisplayName('first');

        expect(publishCount).toBe(afterFirst);
    });
});

describe('chat-store — event queue', () => {
    it('enqueueEvent queues when no waiter; waitForEvent resolves from queue', async () => {
        const store = createChatStore();
        store.enqueueEvent(makeLineEvent('hello'));
        const event = await store.waitForEvent();
        expect(event).toEqual({ type: 'line', value: 'hello' });
    });

    it('enqueueEvent resolves immediately when a waiter exists', async () => {
        const store = createChatStore();
        const promise = store.waitForEvent();
        store.enqueueEvent(makeLineEvent('world'));
        const event = await promise;
        expect(event).toEqual({ type: 'line', value: 'world' });
    });

    it('waitForEvent queues a waiter when the queue is empty', async () => {
        const store = createChatStore();
        const promise = store.waitForEvent();
        store.enqueueEvent({ type: 'interrupt' });
        const event = await promise;
        expect(event.type).toBe('interrupt');
    });
});

describe('chat-store — menus', () => {
    it('setInputMirror updates mirror and resets menuState', () => {
        const store = createChatStore();
        store.setInputMirror('/model');
        const snapshot = store.getSnapshot();
        expect(snapshot.inputMirror).toBe('/model');
        expect(snapshot.menuState.selectedIndex).toBe(0);
    });

    it('navigateSlashMenu changes selectedIndex', () => {
        const store = createChatStore();
        store.setInputMirror('/m');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
        store.navigateSlashMenu('down');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(1);
        store.navigateSlashMenu('up');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
    });

    it('closeMenus resets menuState and fileAutocomplete', () => {
        const store = createChatStore();
        store.setInputMirror('/m');
        store.navigateSlashMenu('down');
        store.closeMenus();
        const snapshot = store.getSnapshot();
        expect(snapshot.menuState.selectedIndex).toBe(0);
        expect(snapshot.fileAutocomplete.open).toBe(false);
    });
});

describe('chat-store — status actions', () => {
    it('setGenerating, setAgentStatus, clearAgentStatus update state', () => {
        const store = createChatStore();
        store.setGenerating(true);
        expect(store.getSnapshot().generating).toBe(true);
        store.setAgentStatus('Running tool...');
        expect(store.getSnapshot().agentStatusText).toBe('Running tool...');
        store.clearAgentStatus();
        expect(store.getSnapshot().agentStatusText).toBe('');
    });

    it('setWorkflowNames and setModelCycleChoices update state', () => {
        const store = createChatStore();
        store.setWorkflowNames(['default', 'planner']);
        expect(store.getSnapshot().workflowNames).toEqual(['default', 'planner']);
        const choices = [makeChoice('a'), makeChoice('b')];
        store.setModelCycleChoices(choices);
        expect(store.getSnapshot().modelCycleChoices).toEqual(choices);
    });

    it('setModelCycleChoices resets index when out of bounds', () => {
        const store = createChatStore();
        store.setModelCycleChoices([makeChoice('a'), makeChoice('b'), makeChoice('c')]);
        store.setModelCycleChoices([makeChoice('only')]);
        expect(store.getSnapshot().modelCycleIndex).toBe(0);
    });
});

describe('chat-store — context token tracking', () => {
    it('contextTokensUsed and contextTokensMax start undefined', () => {
        const store = createChatStore();
        const snapshot = store.getSnapshot();
        expect(snapshot.contextTokensUsed).toBeUndefined();
        expect(snapshot.contextTokensMax).toBeUndefined();
    });

    it('setContextTokensUsed updates the snapshot', () => {
        const store = createChatStore();
        store.setContextTokensUsed(12345);
        expect(store.getSnapshot().contextTokensUsed).toBe(12345);
    });

    it('setContextTokensMax updates the snapshot', () => {
        const store = createChatStore();
        store.setContextTokensMax(200000);
        expect(store.getSnapshot().contextTokensMax).toBe(200000);
    });

    it('setContextTokensUsed(undefined) clears the value', () => {
        const store = createChatStore();
        store.setContextTokensUsed(12345);
        store.setContextTokensUsed(undefined);
        expect(store.getSnapshot().contextTokensUsed).toBeUndefined();
    });

    it('publishing a new context value creates a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.setContextTokensUsed(100);
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.contextTokensUsed).toBe(100);
    });
});

describe('chat-store — model.call.completed usage seam', () => {
    type FakeUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

    function modelCallCompleted(usage: FakeUsage | undefined): AgentEvent {
        const base: AgentEvent = { type: 'model.call.completed', timestamp: '2026-06-30T00:00:00.000Z' };
        if (usage === undefined) return base;
        return {
            ...base,
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'r1',
                sequence: 1,
                message: { messageId: 'm1', role: 'assistant', content: 'ok' },
                finishReason: 'stop',
                usage,
            },
        };
    }

    it('extractUsageFromModelCallCompleted returns inputTokens from the whole event', () => {
        const event = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const result = extractUsageFromModelCallCompleted(event);
        expect(result).toBeDefined();
        expect(result?.inputTokens).toBe(100);
    });

    it('a model.call.completed event drives contextTokensUsed via the onUsage seam', () => {
        const store = createChatStore();
        const event = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const usage = extractUsageFromModelCallCompleted(event);
        store.setContextTokensUsed(usage?.inputTokens);
        expect(store.getSnapshot().contextTokensUsed).toBe(100);
    });

    it('two turns 100 then 250 yields the LATEST value (not a sum)', () => {
        const store = createChatStore();
        const first = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const second = modelCallCompleted({ inputTokens: 250, outputTokens: 80, totalTokens: 330 });
        store.setContextTokensUsed(extractUsageFromModelCallCompleted(first)?.inputTokens);
        store.setContextTokensUsed(extractUsageFromModelCallCompleted(second)?.inputTokens);
        expect(store.getSnapshot().contextTokensUsed).toBe(250);
    });

    it('an event without usage leaves the previous value unchanged', () => {
        const store = createChatStore();
        store.setContextTokensUsed(100);
        const eventWithoutUsage = modelCallCompleted(undefined);
        const usage = extractUsageFromModelCallCompleted(eventWithoutUsage);
        if (usage !== undefined) {
            store.setContextTokensUsed(usage.inputTokens);
        }
        expect(store.getSnapshot().contextTokensUsed).toBe(100);
    });

    it('passing a non-model.call.completed event to extractUsageFromModelCallCompleted returns undefined', () => {
        const wrongEvent: AgentEvent = { type: 'run.completed', timestamp: '2026-06-30T00:00:00.000Z' };
        expect(extractUsageFromModelCallCompleted(wrongEvent)).toBeUndefined();
    });
});

describe('chat-store — snapshot referential stability', () => {
    it('returns the same object reference until a mutation', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        const second = store.getSnapshot();
        expect(second).toBe(first);
        store.setGenerating(true);
        const third = store.getSnapshot();
        expect(third).not.toBe(first);
    });
});

describe('chat-store — ABG minimap toggle', () => {
    it('abgMinimapVisible defaults to false', () => {
        const store = createChatStore();
        expect(store.getSnapshot().abgMinimapVisible).toBe(false);
    });

    it('toggleAbgMinimap flips the flag to true', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('toggleAbgMinimap flips the flag back to false', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(false);
    });

    it('toggleAbgMinimap is independent of overlayMode', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.toggleAbgOverlay();
        expect(store.getSnapshot().overlayMode).toBe('abg');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('abgMinimapVisible persists when an unrelated modal opens and closes', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        store.showApproval('file.edit', 'edit x.ts');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('toggleAbgMinimap publishes a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.toggleAbgMinimap();
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.abgMinimapVisible).toBe(true);
    });
});

describe('chat-store — onModelCycleSelect callback', () => {
    it('fires the callback when set', () => {
        const store = createChatStore();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };
        store.onModelCycleSelect?.(makeSelection('p', 'm'));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ providerID: 'p', modelID: 'm' });
    });
});

describe('chat-store — cycleModelVariant', () => {
    // Fixtures tied to the real catalog: openai/gpt-5 has 4 reasoning variants;
    const GPT5_SELECTION: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-5' };
    const NO_VARIANT_SELECTION: ModelProviderSelection = {
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
    };

    function createStoreWithCurrentChoice(selection: ModelProviderSelection): ChatStore {
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('current', selection),
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
        ]);
        return store;
    }

    it('starts at unset and advances forward through the rotation', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-minimal');
        expect(calls).toEqual([{ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-minimal' }]);

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');
    });

    it('cycles backward from unset to the last variant (wrap)', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(-1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-high');
    });

    it('wraps forward from the last variant back to unset', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('includes unset in the rotation: selecting unset clears variantID from the selection', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(-1);
        store.cycleModelVariant(-1);

        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        const lastCall = calls.at(-1);
        expect(lastCall).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
        expect(lastCall?.variantID).toBeUndefined();
    });

    it('emits a "No variants" transient notice and does not cycle when the model has no variants', () => {
        const store = createStoreWithCurrentChoice(NO_VARIANT_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(calls).toHaveLength(0);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getSnapshot().transientNotice?.message).toBe('No variants for openai/gpt-4o-mini');
        expect(store.getOutput()).not.toContain('No variants for openai/gpt-4o-mini');
    });

    it('updates the current variant without writing to outputText', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBeDefined();
        expect(store.getOutput()).not.toContain('Cycle variant');

        store.cycleModelVariant(-1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getOutput()).not.toContain('Cycle variant');
    });

    it('is a no-op when modelCycleChoices is empty', () => {
        const store = createChatStore();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(calls).toHaveLength(0);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('resets currentModelVariantID to unset when cycleModel switches the base model', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');

        store.cycleModel(1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });
});

describe('chat-store — setModelSelection', () => {
    // Fixtures tied to the real catalog: openai/gpt-5 has 4 reasoning variants.
    const GPT5_SELECTION: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-5' };

    function createStoreWithGpt5First(): ChatStore {
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('gpt-5', GPT5_SELECTION),
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
        ]);
        return store;
    }

    it('updates currentModelSelection, currentModelVariantID, and re-aligns modelCycleIndex', () => {
        const store = createStoreWithGpt5First();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.setModelSelection({ providerID: 'other', modelID: 'other-model', variantID: 'v1' });

        const snap = store.getSnapshot();
        expect(snap.currentModelSelection).toEqual({
            providerID: 'other',
            modelID: 'other-model',
            variantID: 'v1',
        });
        expect(snap.currentModelVariantID).toBe('v1');
        expect(snap.modelCycleIndex).toBe(1);
        expect(calls).toEqual([{ providerID: 'other', modelID: 'other-model', variantID: 'v1' }]);
    });

    it('clears currentModelVariantID when selection has no variantID', () => {
        const store = createStoreWithGpt5First();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-low' });
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');

        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5' });
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('leaves modelCycleIndex unchanged when the selection base is not in modelCycleChoices', () => {
        const store = createStoreWithGpt5First();
        expect(store.getSnapshot().modelCycleIndex).toBe(0);

        store.setModelSelection({ providerID: 'unknown', modelID: 'mystery' });

        expect(store.getSnapshot().currentModelSelection).toEqual({
            providerID: 'unknown',
            modelID: 'mystery',
        });
        expect(store.getSnapshot().modelCycleIndex).toBe(0);
    });

    it('cycleModelVariant targets the model selected via setModelSelection (the Ctrl+V bug repro)', () => {
        // Bug repro: user is on gpt-5 (index 0), switches to "other" via a
        // non-cycle path (F2/leader+N or `/model`), then presses Ctrl+V.
        // Before the fix Ctrl+V read the stale index 0 and cycled gpt-5's
        // variants. After the fix it must operate on "other".
        const store = createStoreWithGpt5First();
        // "other/other-model" has no variants in the real catalog, so the
        // "No variants" notice should name that model, not openai/gpt-5.
        store.setModelSelection({ providerID: 'other', modelID: 'other-model' });

        store.cycleModelVariant(1);

        expect(store.getSnapshot().transientNotice?.message).toBe('No variants for other/other-model');
        expect(store.getOutput()).not.toContain('No variants for other/other-model');
        expect(store.getOutput()).not.toContain('openai/gpt-5');
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });

    it('cycleModelVariant rotates the variant of a setModelSelection-selected model with variants', () => {
        // Switch to anthropic/claude-opus-4-1 (has thinking-* variants) via a
        // non-cycle path, then verify Ctrl+V rotates that model's variants.
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('gpt-5', GPT5_SELECTION),
            makeChoice('opus', { providerID: 'anthropic', modelID: 'claude-opus-4-1' }),
        ]);
        store.setModelSelection({ providerID: 'anthropic', modelID: 'claude-opus-4-1' });
        expect(store.getSnapshot().modelCycleIndex).toBe(1);

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('thinking-low');
        expect(store.getSnapshot().currentModelSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-opus-4-1',
            variantID: 'thinking-low',
        });
    });

    it('setModelCycleChoices re-aligns modelCycleIndex to the current selection', () => {
        const store = createChatStore();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5' });
        expect(store.getSnapshot().modelCycleIndex).toBe(0);

        // Rebuild the choices list with gpt-5 NOT first; the store should
        // re-find it on the next setModelCycleChoices call.
        store.setModelCycleChoices([
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
            makeChoice('gpt-5', GPT5_SELECTION),
        ]);
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });
});

describe('chat-store — session picker overlay', () => {
    it('showSessionPicker sets overlayMode and returns a Promise', () => {
        const store = createChatStore();
        const entries = [makeSessionEntry('s1', 'Session 1'), makeSessionEntry('s2', 'Session 2')];
        const promise = store.showSessionPicker(entries);
        expect(promise).toBeInstanceOf(Promise);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('session-picker');
        expect(snapshot.sessionPickerEntries).toEqual(entries);
        store.hideSessionPicker();
    });

    it('hideSessionPicker(sessionId) resolves the promise with that sessionId', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1'), makeSessionEntry('s2')]);
        store.hideSessionPicker('s2');
        const result = await promise;
        expect(result).toBe('s2');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('hideSessionPicker() (cancel) resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1')]);
        store.hideSessionPicker();
        expect(await promise).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showSessionPicker with empty entries resolves undefined without opening overlay', async () => {
        const store = createChatStore();
        const result = await store.showSessionPicker([]);
        expect(result).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('updateSessionPickerSearch narrows visible entries', () => {
        const store = createChatStore();
        const entries = [
            makeSessionEntry('s1', 'Feature work'),
            makeSessionEntry('s2', 'Bug fix'),
            makeSessionEntry('s3', 'Feature refactor'),
        ];
        store.showSessionPicker(entries);
        store.updateSessionPickerSearch('feature');
        const snapshot = store.getSnapshot();
        const view = createSessionPickerView(snapshot.sessionPickerKeypress, snapshot.sessionPickerEntries, 10);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 's3']);
        store.hideSessionPicker();
    });

    it('confirmSessionPicker resolves the selected sessionId', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([
            makeSessionEntry('s1'),
            makeSessionEntry('s2'),
            makeSessionEntry('s3'),
        ]);
        store.updateSessionPickerSearch('\u001b[B');
        store.confirmSessionPicker();
        expect(await promise).toBe('s2');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('cancelSessionPicker resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1')]);
        store.cancelSessionPicker();
        expect(await promise).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('createSessionPickerView — pure view helper', () => {
    it('returns all entries when searchQuery is empty', () => {
        const state = createProviderPromptKeypressState();
        const entries = [makeSessionEntry('s1', 'One'), makeSessionEntry('s2', 'Two')];
        const view = createSessionPickerView(state, entries, 5);
        expect(view.totalCount).toBe(2);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 's2']);
    });

    it('filters entries by searchQuery against sessionId and label', () => {
        const state = { ...createProviderPromptKeypressState(), searchQuery: 'feat' };
        const entries = [
            makeSessionEntry('s1', 'Feature work'),
            makeSessionEntry('s2', 'Bug fix'),
            makeSessionEntry('feat-2', 'Refactor'),
        ];
        const view = createSessionPickerView(state, entries, 10);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 'feat-2']);
    });

    it('windows visible entries to maxVisible', () => {
        const entries = Array.from({ length: 10 }, (_, i) => makeSessionEntry(`s${i}`, `Session ${i}`));
        const state = createProviderPromptKeypressState();
        const view = createSessionPickerView(state, entries, 3);
        expect(view.visibleEntries).toHaveLength(3);
        expect(view.startIndex).toBe(0);
        expect(view.visibleEntries.map((e) => e.sessionId)).toEqual(['s0', 's1', 's2']);
    });

    it('clamps selectedIndex to filteredCount - 1', () => {
        const entries = [makeSessionEntry('s1', 'One'), makeSessionEntry('s2', 'Two'), makeSessionEntry('s3', 'Three')];
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 5 };
        const view = createSessionPickerView(state, entries, 10);
        expect(view.selectedIndex).toBe(2);
    });

    it('clamps selectedIndex to 0 when the filtered set is empty', () => {
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 3 };
        const view = createSessionPickerView(state, [], 5);
        expect(view.selectedIndex).toBe(0);
        expect(view.totalCount).toBe(0);
        expect(view.visibleEntries).toEqual([]);
    });

    it('re-centers the window when the selection moves past the middle', () => {
        const entries = Array.from({ length: 10 }, (_, i) => makeSessionEntry(`s${i}`, `Session ${i}`));
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 7 };
        const view = createSessionPickerView(state, entries, 3);
        expect(view.selectedIndex).toBe(7);
        expect(view.startIndex).toBe(6);
        expect(view.visibleEntries.map((e) => e.sessionId)).toEqual(['s6', 's7', 's8']);
    });
});

describe('chat-store — agents dashboard overlay', () => {
    function makeAgentEntry(name: string, source: string = 'bundled'): DashboardAgentEntry {
        return { name, description: name, source, disabled: false };
    }

    it('showAgentsDashboard sets active=true and populates agents from passed-in entries', () => {
        const store = createChatStore();
        const entries = [makeAgentEntry('oracle'), makeAgentEntry('quick')];
        store.showAgentsDashboard(entries);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('agents-dashboard');
        expect(snapshot.agentsDashboard.active).toBe(true);
        expect(snapshot.agentsDashboard.agents).toEqual(entries);
        expect(snapshot.agentsDashboard.selectedIndex).toBe(0);
        expect(snapshot.agentsDashboard.sourceTab).toBe('all');
        expect(snapshot.agentsDashboard.editingName).toBeNull();
    });

    it('hideAgentsDashboard sets active=false and clears edit state', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.hideAgentsDashboard();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.agentsDashboard.active).toBe(false);
        expect(snapshot.agentsDashboard.editingName).toBeNull();
    });

    it('navigateAgentsDashboard clamps at bounds', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
        store.navigateAgentsDashboard(-5);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('navigateAgentsDashboard is a no-op when the filtered list is empty', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a', 'project')]);
        store.cycleAgentsDashboardSourceTab(2);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('user');
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('cycleAgentsDashboardSourceTab cycles all -> project -> user -> bundled', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a', 'project'), makeAgentEntry('b', 'bundled')]);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('all');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('project');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('user');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('bundled');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('all');
    });

    it('cycleAgentsDashboardSourceTab wraps backward', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a')]);
        store.cycleAgentsDashboardSourceTab(-1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('bundled');
    });

    it('toggleAgentsDashboardAgentDisabled flips the in-memory disabled flag', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(false);
        store.toggleAgentsDashboardAgentDisabled('oracle');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(true);
        store.toggleAgentsDashboardAgentDisabled('oracle');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(false);
    });

    it('beginAgentsDashboardModelEdit seeds editBuffer from the override model', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            overrideModel: 'anthropic/claude-sonnet-4-6',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBe('oracle');
        expect(snap.agentsDashboard.editBuffer).toBe('anthropic/claude-sonnet-4-6');
    });

    it('beginAgentsDashboardModelEdit falls back to the base model when no override exists', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            model: 'mctrl/slow',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        expect(store.getSnapshot().agentsDashboard.editBuffer).toBe('mctrl/slow');
    });

    it('commitAgentsDashboardModelEdit updates overrideModel in memory', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.commitAgentsDashboardModelEdit('openai/gpt-5');
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBeNull();
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBe('openai/gpt-5');
    });

    it('commitAgentsDashboardModelEdit(undefined) clears the override', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            overrideModel: 'openai/gpt-5',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.commitAgentsDashboardModelEdit(undefined);
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('commitAgentsDashboardModelEdit is a no-op when no edit is active', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.commitAgentsDashboardModelEdit('openai/gpt-5');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('cancelAgentsDashboardModelEdit clears edit state without committing', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.cancelAgentsDashboardModelEdit();
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBeNull();
        expect(snap.agentsDashboard.editBuffer).toBe('');
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('reloadAgentsDashboard preserves selection when agent still present', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(2);
        store.reloadAgentsDashboard([
            makeAgentEntry('a'),
            makeAgentEntry('b'),
            makeAgentEntry('c'),
            makeAgentEntry('d'),
        ]);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
    });

    it('reloadAgentsDashboard resets selection when agent is gone', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(2);
        store.reloadAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b')]);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('source-tab filter narrows navigation to matching entries', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            makeAgentEntry('a', 'project'),
            makeAgentEntry('b', 'bundled'),
            makeAgentEntry('c', 'project'),
        ]);
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('project');
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
    });
});

describe('createAgentsDashboardView — pure view helper', () => {
    function makeAgentEntry(name: string, source: string = 'bundled'): DashboardAgentEntry {
        return { name, description: name, source, disabled: false };
    }

    function dashboardState(overrides?: Partial<AgentsDashboardState>): AgentsDashboardState {
        return {
            active: true,
            agents: [],
            selectedIndex: 0,
            sourceTab: 'all',
            editingName: null,
            editBuffer: '',
            ...overrides,
        };
    }

    it('returns totalCount 0 and null inspectorEntry for empty agents', () => {
        const view = createAgentsDashboardView(dashboardState({ agents: [] }), 10);
        expect(view.totalCount).toBe(0);
        expect(view.inspectorEntry).toBeNull();
        expect(view.visibleEntries).toEqual([]);
        expect(view.startIndex).toBe(0);
        expect(view.endIndex).toBe(0);
    });

    it('windows 12 agents with maxVisible=10 and selectedIndex=11 to {startIndex:2, endIndex:11, totalCount:12}', () => {
        const agents = Array.from({ length: 12 }, (_, i) => makeAgentEntry(`a${i}`));
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 11 }), 10);
        expect(view.startIndex).toBe(2);
        expect(view.endIndex).toBe(11);
        expect(view.totalCount).toBe(12);
        expect(view.visibleEntries).toHaveLength(10);
        expect(view.selectedIndex).toBe(11);
    });

    it('source-tab filter project returns only source===project entries', () => {
        const agents = [makeAgentEntry('a', 'project'), makeAgentEntry('b', 'bundled'), makeAgentEntry('c', 'project')];
        const view = createAgentsDashboardView(dashboardState({ agents, sourceTab: 'project' }), 10);
        expect(view.totalCount).toBe(2);
        expect(view.visibleEntries.map((e) => e.name)).toEqual(['a', 'c']);
    });

    it('sourceTabs counts reflect the FULL agent list regardless of active tab', () => {
        const agents = [
            makeAgentEntry('a', 'project'),
            makeAgentEntry('b', 'bundled'),
            makeAgentEntry('c', 'user'),
            makeAgentEntry('d', 'project'),
        ];
        const view = createAgentsDashboardView(dashboardState({ agents, sourceTab: 'project' }), 10);
        const counts = Object.fromEntries(view.sourceTabs.map((t) => [t.id, t.count]));
        expect(counts).toEqual({ all: 4, project: 2, user: 1, bundled: 1 });
    });

    it('inspectorEntry returns the currently-selected entry', () => {
        const agents = [makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')];
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 1 }), 10);
        expect(view.inspectorEntry?.name).toBe('b');
    });

    it('clamps selectedIndex to filtered count - 1', () => {
        const agents = [makeAgentEntry('a'), makeAgentEntry('b')];
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 10 }), 10);
        expect(view.selectedIndex).toBe(1);
    });

    it('re-centers the window when selection moves past the middle', () => {
        const agents = Array.from({ length: 12 }, (_, i) => makeAgentEntry(`a${i}`));
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 0 }), 3);
        expect(view.startIndex).toBe(0);
        expect(view.visibleEntries.map((e) => e.name)).toEqual(['a0', 'a1', 'a2']);
    });
});

describe('chat-store — mission panel overlay', () => {
    function makeMissionRow(id: string, label?: string): MissionPanelRow {
        return { id, label: label ?? id };
    }

    it('showMissionPanel sets overlayMode and initializes the slice with default tab and reload metadata', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1'), makeMissionRow('r2')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('mission-panel');
        expect(snapshot.missionPanel.active).toBe(true);
        expect(snapshot.missionPanel.activeTab).toBe('runs');
        expect(snapshot.missionPanel.rows.map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
        expect(snapshot.missionPanel.count).toBe(2);
    });

    it('showMissionPanel with no rows initializes an empty-state slice without crashing', () => {
        const store = createChatStore();
        store.showMissionPanel();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('mission-panel');
        expect(snapshot.missionPanel.active).toBe(true);
        expect(snapshot.missionPanel.rows).toEqual([]);
        expect(snapshot.missionPanel.count).toBe(0);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
    });

    it('hideMissionPanel clears the overlay and deactivates the slice', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        store.hideMissionPanel();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.missionPanel.active).toBe(false);
    });

    it('navigateMissionPanel moves the cursor down and up within bounds', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
        store.navigateMissionPanel(-1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
    });

    it('navigateMissionPanel clamps at the upper bound', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
    });

    it('navigateMissionPanel clamps at the lower bound with a large negative delta', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(-5);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('navigateMissionPanel is a no-op when there are no rows', () => {
        const store = createChatStore();
        store.showMissionPanel();
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('setMissionPanelTab switches the active tab', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        const tabs: readonly MissionPanelTab[] = ['runs', 'jobs', 'agents', 'drain', 'continue'];
        for (const tab of tabs) {
            store.setMissionPanelTab(tab);
            expect(store.getSnapshot().missionPanel.activeTab).toBe(tab);
        }
    });

    it('setMissionPanelTab is a no-op when the tab is already active', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.setMissionPanelTab('runs');
        expect(publishCount).toBe(0);
    });

    it('setMissionPanelTab clamps selectedIndex into range when switching', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.setMissionPanelTab('jobs');
        expect(store.getSnapshot().missionPanel.activeTab).toBe('jobs');
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
    });

    it('reloadMissions refreshes rows and reload metadata', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a')]);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect(snapshot.missionPanel.count).toBe(3);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
    });

    it('reloadMissions preserves the selected row when it is still present', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c'), makeMissionRow('d')]);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
    });

    it('reloadMissions resets selection to 0 when the selected row is gone', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b')]);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('reloadMissions is a no-op when the panel is not active', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a')]);
        store.hideMissionPanel();
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.reloadMissions([makeMissionRow('z')]);
        expect(publishCount).toBe(0);
        expect(store.getSnapshot().missionPanel.rows.map((r) => r.id)).toEqual(['a']);
    });

    it('publishing a new mission panel value creates a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.showMissionPanel([makeMissionRow('a')]);
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.missionPanel.active).toBe(true);
    });

    it('navigateMissionPanel on a single-row list is a no-op in both directions', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('only')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
        store.navigateMissionPanel(-1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('reloadMissions transitioning to an empty list resets selection to 0', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.reloadMissions([]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.rows).toEqual([]);
        expect(snapshot.missionPanel.count).toBe(0);
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
    });

    it('showMissionPanel resets selectedIndex and activeTab when re-opening after navigation', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        store.setMissionPanelTab('jobs');
        store.showMissionPanel([makeMissionRow('x'), makeMissionRow('y')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
        expect(snapshot.missionPanel.activeTab).toBe('runs');
    });
});
