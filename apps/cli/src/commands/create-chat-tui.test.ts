import { describe, expect, it } from 'vitest';
import { createChatTuiHandle } from './create-chat-tui.js';
import { createChatStore } from './chat-store.js';

describe('create-chat-tui', () => {
    it('returns a handle structurally assignable to OpenTuiChatBridge', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});

        expect(typeof handle.waitForEvent).toBe('function');
        expect(typeof handle.emitOutput).toBe('function');
        expect(typeof handle.replaceOutputText).toBe('function');
        expect(typeof handle.getOutput).toBe('function');
        expect(typeof handle.showModelPicker).toBe('function');
        expect(typeof handle.showLevelPicker).toBe('function');
        expect(typeof handle.setApprovalLevel).toBe('function');
        expect(typeof handle.setModelCycleChoices).toBe('function');
        expect(typeof handle.setGenerating).toBe('function');
        expect(typeof handle.setWorkflowNames).toBe('function');
        expect(typeof handle.setAgentStatus).toBe('function');
        expect(typeof handle.clearAgentStatus).toBe('function');
        expect(typeof handle.isShowThinking).toBe('function');
        expect(typeof handle.isToolOutputExpanded).toBe('function');
        expect(typeof handle.showApproval).toBe('function');
        expect(typeof handle.hideApproval).toBe('function');
        expect(typeof handle.showQuestion).toBe('function');
        expect(typeof handle.applyAbgOverlayPrefs).toBe('function');
        expect(typeof handle.getAbgOverlayPrefsSnapshot).toBe('function');
        expect(typeof handle.unmount).toBe('function');
        expect('onModelCycleSelect' in handle).toBe(true);
        expect('onRenameSubmit' in handle).toBe(true);
    });

    it('emitOutput delegates to store', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        handle.emitOutput('test text\n');
        // getOutput reads state directly (emitOutput updates state synchronously,
        // snapshot publish is coalesced via setTimeout)
        expect(handle.getOutput()).toContain('test text');
    });

    it('setGenerating delegates to store', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        handle.setGenerating(true);
        expect(store.getSnapshot().generating).toBe(true);
    });

    it('isShowThinking reads from store snapshot', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        expect(handle.isShowThinking()).toBe(store.getSnapshot().showThinking);
    });

    it('isToolOutputExpanded reads from store snapshot', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        expect(handle.isToolOutputExpanded()).toBe(store.getSnapshot().toolOutputExpanded);
    });

    it('applyAbgOverlayPrefs writes through to store snapshot', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        handle.applyAbgOverlayPrefs({
            activeTabIndex: 2,
            scrollOffset: 10,
            liveOutput: true,
            showThinking: false,
            toolOutputExpanded: true,
        });
        const snap = store.getAbgOverlayPrefsSnapshot();
        expect(snap.activeTabIndex).toBe(2);
        expect(snap.scrollOffset).toBe(10);
        expect(snap.liveOutput).toBe(true);
        expect(snap.showThinking).toBe(false);
        expect(snap.toolOutputExpanded).toBe(true);
    });

    it('getAbgOverlayPrefsSnapshot returns current prefs', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        const snap = handle.getAbgOverlayPrefsSnapshot();
        expect(snap).toEqual(store.getAbgOverlayPrefsSnapshot());
    });

    it('onModelCycleSelect getter/setter delegates to store', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        const callback = (): void => {};
        handle.onModelCycleSelect = callback;
        expect(handle.onModelCycleSelect).toBe(callback);
        expect(store.onModelCycleSelect).toBe(callback);
    });

    it('onRenameSubmit getter/setter delegates to store', () => {
        const store = createChatStore();
        const handle = createChatTuiHandle(store, () => {});
        const callback = (name: string): void => {
            void name;
        };
        handle.onRenameSubmit = callback;
        expect(handle.onRenameSubmit).toBe(callback);
        expect(store.onRenameSubmit).toBe(callback);
    });

    it('unmount calls the provided unmount function', () => {
        let called = false;
        const handle = createChatTuiHandle(createChatStore(), () => {
            called = true;
        });
        handle.unmount();
        expect(called).toBe(true);
    });
});
