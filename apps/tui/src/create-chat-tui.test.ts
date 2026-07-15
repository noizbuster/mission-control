import { describe, expect, it } from 'vitest';
import { type ChatTuiOptions, createChatTuiHandle } from './create-chat-tui';
import type { ChatTuiHandle } from './state/chat-tui-types';
import { createAbgOverlayController, createAbgOverlayStore, createChatStore } from './state/index';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readCreateChatTuiSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/create-chat-tui.tsx'), 'utf8');
}

const CHAT_TUI_HANDLE_METHODS = [
    'waitForEvent',
    'emitOutput',
    'replaceOutputText',
    'getOutput',
    'showModelPicker',
    'showSessionPicker',
    'showAgentsDashboard',
    'reloadAgentsDashboard',
    'hideAgentsDashboard',
    'showMissionPanel',
    'reloadMissions',
    'hideMissionPanel',
    'showModelsOverlay',
    'showLevelPicker',
    'setApprovalLevel',
    'setSessionId',
    'setSessionDisplayName',
    'setContextTokensUsed',
    'setModelCycleChoices',
    'setModelSelection',
    'setGenerating',
    'setWorkflowNames',
    'setAgentStatus',
    'clearAgentStatus',
    'showTransientNotice',
    'isShowThinking',
    'isToolOutputExpanded',
    'showApproval',
    'hideApproval',
    'showQuestion',
    'showQuestionBatch',
    'applyAbgOverlayPrefs',
    'getAbgOverlayPrefsSnapshot',
    'unmount',
] as const;

describe('create-chat-tui', () => {
    it('returns a handle structurally assignable to ChatTuiHandle with full method surface', () => {
        const store = createChatStore();
        const handle: ChatTuiHandle = createChatTuiHandle(store, () => {});

        for (const method of CHAT_TUI_HANDLE_METHODS) {
            expect(typeof handle[method]).toBe('function');
        }
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

    it('unmount calls the provided unmount function once when invoked repeatedly', () => {
        let calls = 0;
        const handle = createChatTuiHandle(createChatStore(), () => {
            calls += 1;
        });
        handle.unmount();
        handle.unmount();
        expect(calls).toBe(1);
    });

    it('ChatTuiOptions accepts abgOverlayController and the controller.store satisfies AbgOverlayStore', () => {
        const controller = createAbgOverlayController(createAbgOverlayStore());
        const options: ChatTuiOptions = {
            providerID: 'local',
            modelID: 'local-echo',
            abgOverlayController: controller,
        };
        expect(options.abgOverlayController).toBe(controller);
        const store = options.abgOverlayController?.store;
        expect(typeof store?.subscribe).toBe('function');
        expect(typeof store?.getSnapshot).toBe('function');
        expect(typeof store?.update).toBe('function');
    });

    it('mount path dynamically imports the provider composition root instead of the keymap provider directly', () => {
        const source = readCreateChatTuiSource();

        expect(source).toContain("await import('@mission-control/tui/providers')");
        expect(source).toContain('createComponent(MissionControlTuiProviders');
        expect(source).not.toContain("await import('@mission-control/tui/keymap-provider')");
    });

    it('mounts App with store-only props and no external ref or chrome fan-out', () => {
        const source = readCreateChatTuiSource();

        expect(source).toContain('createComponent(App, { store })');
        expect(source).not.toContain('textareaRef:');
        expect(source).not.toContain('scrollboxRef:');
        expect(source).not.toContain('statusBarProps');
        expect(source).not.toContain('welcomeData');
        expect(source).not.toContain('setTextareaRef');
        expect(source).not.toContain('setScrollboxRef');
        expect(source).not.toContain('abgOverlayController:');
        expect(source).not.toContain('missionControlServices:');
        expect(source).not.toContain('actions:');
    });
});
