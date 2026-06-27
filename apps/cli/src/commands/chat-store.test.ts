import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelChoice } from './interactive-chat-model.js';
import {
    createChatStore,
    createSessionPickerView,
    type ChatStore,
    type SessionPickerEntry,
} from './chat-store.js';
import { createProviderPromptKeypressState } from './auth-provider-keypress.js';
import type { ChatInputEvent } from './interactive-chat-io.js';

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
        const promise = store.showSessionPicker([makeSessionEntry('s1'), makeSessionEntry('s2'), makeSessionEntry('s3')]);
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
        const entries = [
            makeSessionEntry('s1', 'One'),
            makeSessionEntry('s2', 'Two'),
            makeSessionEntry('s3', 'Three'),
        ];
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
