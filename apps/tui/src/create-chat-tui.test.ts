import { describe, expect, it } from 'vitest';
import { type ChatTuiOptions, createChatTuiHandle } from './create-chat-tui';
import type { ChatTuiHandle } from './state/chat-tui-types';
import { createAbgOverlayController, createAbgOverlayStore, createChatStore } from './state/index';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TranscriptPart =
    | { readonly id: string; readonly type: 'user'; readonly text: string }
    | { readonly id: string; readonly type: 'assistant'; readonly text: string }
    | { readonly id: string; readonly type: 'reasoning'; readonly text: string }
    | { readonly id: string; readonly type: 'inline-tool'; readonly text: string }
    | { readonly id: string; readonly type: 'block-tool'; readonly text: string }
    | { readonly id: string; readonly type: 'diff'; readonly text: string }
    | { readonly id: string; readonly type: 'code'; readonly text: string }
    | { readonly id: string; readonly type: 'command'; readonly text: string }
    | { readonly id: string; readonly type: 'subagent'; readonly text: string }
    | { readonly id: string; readonly type: 'status'; readonly text: string }
    | { readonly id: string; readonly type: 'event'; readonly text: string }
    | { readonly id: string; readonly type: 'error'; readonly text: string }
    | { readonly id: string; readonly type: 'legacy'; readonly text: string };

type TypedTranscriptHandle = {
    readonly emitTranscriptPart: (part: TranscriptPart, fallbackText: string) => void;
    readonly replaceTranscript: (parts: readonly TranscriptPart[], outputText: string) => void;
};

type TypedTranscriptSnapshot = {
    readonly transcriptParts: readonly TranscriptPart[];
};

type TypedTranscriptStore = {
    readonly getSnapshot: () => TypedTranscriptSnapshot;
};

function hasTypedTranscriptHandle(value: object): value is TypedTranscriptHandle {
    return (
        'emitTranscriptPart' in value &&
        typeof value.emitTranscriptPart === 'function' &&
        'replaceTranscript' in value &&
        typeof value.replaceTranscript === 'function'
    );
}

function hasTypedTranscriptSnapshot(value: unknown): value is TypedTranscriptSnapshot {
    return (
        typeof value === 'object' &&
        value !== null &&
        'transcriptParts' in value &&
        Array.isArray(value.transcriptParts)
    );
}

function hasTypedTranscriptStore(value: object): value is TypedTranscriptStore {
    if (!('getSnapshot' in value) || typeof value.getSnapshot !== 'function') return false;
    return hasTypedTranscriptSnapshot(value.getSnapshot());
}

function readCreateChatTuiSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/create-chat-tui.tsx'), 'utf8');
}

const CHAT_TUI_HANDLE_METHODS = [
    'waitForEvent',
    'emitOutput',
    'emitTranscriptPart',
    'replaceOutputText',
    'replaceTranscript',
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
    'setContextTokensMax',
    'setModelCycleChoices',
    'setModelSelection',
    'setGenerating',
    'setWorkflowNames',
    'setSkillNames',
    'setAgentStatus',
    'setAgentRetryStatus',
    'clearAgentStatus',
    'showTransientNotice',
    'setStickyNotice',
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
    it('requires the typed transcript handle seam before the imperative loop can emit rich parts', () => {
        // Given: the current handle built from a concrete ChatStore.
        const handle = createChatTuiHandle(createChatStore(), () => {});

        // When: the capability is inspected without a static missing-member reference.
        const supportsTypedTranscript = hasTypedTranscriptHandle(handle);

        // Then: the missing handle seam reports the explicit RED contract failure.
        expect(
            supportsTypedTranscript,
            'ChatTuiHandle must expose emitTranscriptPart(part, fallbackText) and replaceTranscript(parts, outputText).',
        ).toBe(true);
    });

    it('forwards typed transcript emission and replacement through the handle to the store', () => {
        // Given: a handle and store joined by the existing imperative seam.
        const store = createChatStore();
        const transcriptStore: object = store;
        const handle = createChatTuiHandle(store, () => {});
        if (!hasTypedTranscriptHandle(handle) || !hasTypedTranscriptStore(transcriptStore)) return;
        const assistantPart: TranscriptPart = {
            id: 'assistant-handle-1',
            type: 'assistant',
            text: 'The handle emitted this rich response.',
        };
        const replacementParts: readonly TranscriptPart[] = [
            { id: 'user-handle-1', type: 'user', text: 'Restore the replay.' },
        ];

        // When: the imperative caller emits then replaces typed transcript state.
        handle.emitTranscriptPart(assistantPart, 'Assistant: The handle emitted this rich response.\n');
        handle.replaceTranscript(replacementParts, 'You: Restore the replay.\n');

        // Then: the store is the single observable owner of both projections.
        expect(transcriptStore.getSnapshot().transcriptParts).toEqual(replacementParts);
        expect(store.getOutput()).toBe('You: Restore the replay.\n');
    });

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
