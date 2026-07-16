import type { ProviderAuthStore } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatStore, createChatStore } from '../state/chat-store';
import { createModelsOverlayRoleRows } from '../state/models-overlay-state';

function selection(providerID: string, modelID: string, variantID?: string): ModelProviderSelection {
    return { providerID, modelID, ...(variantID !== undefined ? { variantID } : {}) };
}

const ENTRIES = [selection('p1', 'm1'), selection('p2', 'm2'), selection('p3', 'm3')] as const;
const FALLBACK = selection('a', 'b');

function recordingAuthStore(): ProviderAuthStore & {
    readonly setModelRoleMock: ReturnType<typeof vi.fn>;
    readonly clearModelRoleMock: ReturnType<typeof vi.fn>;
    readonly getModelRolesMock: ReturnType<typeof vi.fn>;
} {
    const setModelRoleMock = vi.fn();
    const clearModelRoleMock = vi.fn();
    const getModelRolesMock = vi.fn().mockResolvedValue({});
    return {
        authFilePath: '/tmp/mission-control-models-overlay-test.json',
        readAuthFile: async () => ({ $schema: 'https://mission-control.local/auth.schema.json', credentials: {} }),
        saveCredential: async () => {},
        updateOAuthCredential: async () => {},
        setDefaultSelection: async () => {},
        deleteCredential: async () => {},
        listCredentialSummaries: async () => [],
        getDefaultSelection: async () => undefined,
        getModelRoles: getModelRolesMock,
        setModelRole: setModelRoleMock,
        clearModelRole: clearModelRoleMock,
        setModelRoleMock,
        clearModelRoleMock,
        getModelRolesMock,
    };
}

function openOverlay(store: ChatStore): void {
    store.showModelsOverlay(ENTRIES, createModelsOverlayRoleRows({}, FALLBACK));
}

describe('ChatStore models-overlay wiring (headless)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('showModelsOverlay activates the overlay and seeds both columns', () => {
        const store = createChatStore();
        openOverlay(store);
        const snapshot = store.getSnapshot();

        expect(snapshot.overlayMode).toBe('models-overlay');
        expect(snapshot.modelsOverlay.active).toBe(true);
        expect(snapshot.modelsOverlay.entries).toEqual(ENTRIES);
        expect(snapshot.modelsOverlay.roleRows).toHaveLength(10);
        expect(snapshot.modelsOverlay.focusedColumn).toBe('left');
        expect(snapshot.modelsOverlay.activeLeftIndex).toBe(0);
    });

    it('navigateModelsOverlay moves the active index within the focused column', () => {
        const store = createChatStore();
        openOverlay(store);

        store.navigateModelsOverlay(1);
        expect(store.getSnapshot().modelsOverlay.activeLeftIndex).toBe(1);

        store.navigateModelsOverlay(-1);
        expect(store.getSnapshot().modelsOverlay.activeLeftIndex).toBe(0);
    });

    it('navigateModelsOverlay is a no-op before the overlay is shown', () => {
        const store = createChatStore();
        store.navigateModelsOverlay(1);
        expect(store.getSnapshot().modelsOverlay.activeLeftIndex).toBe(0);
    });

    it('switchModelsOverlayColumn toggles the focused column', () => {
        const store = createChatStore();
        openOverlay(store);

        expect(store.getSnapshot().modelsOverlay.focusedColumn).toBe('left');
        store.switchModelsOverlayColumn();
        expect(store.getSnapshot().modelsOverlay.focusedColumn).toBe('right');
        store.switchModelsOverlayColumn();
        expect(store.getSnapshot().modelsOverlay.focusedColumn).toBe('left');
    });

    it('assignModelsOverlayRole updates the role row and persists via authStore', async () => {
        const authStore = recordingAuthStore();
        const store = createChatStore({ authStore });
        openOverlay(store);

        await store.assignModelsOverlayRole('slow', selection('p1', 'm1'));

        const slowRow = store.getSnapshot().modelsOverlay.roleRows.find((row) => row.role === 'slow');
        expect(slowRow?.assignment).toEqual(selection('p1', 'm1'));
        expect(authStore.setModelRoleMock).toHaveBeenCalledOnce();
        expect(authStore.setModelRoleMock).toHaveBeenCalledWith('slow', selection('p1', 'm1'));
    });

    it('assignModelsOverlayRole updates state even without an authStore', async () => {
        const store = createChatStore();
        openOverlay(store);

        await store.assignModelsOverlayRole('vision', selection('p2', 'm2'));

        const visionRow = store.getSnapshot().modelsOverlay.roleRows.find((row) => row.role === 'vision');
        expect(visionRow?.assignment).toEqual(selection('p2', 'm2'));
    });

    it('clearModelsOverlayRole resets the role row and persists via authStore', async () => {
        const authStore = recordingAuthStore();
        const roleRows = createModelsOverlayRoleRows({ slow: selection('p1', 'm1') }, FALLBACK);
        const store = createChatStore({ authStore });
        store.showModelsOverlay(ENTRIES, roleRows);

        await store.clearModelsOverlayRole('slow');

        const slowRow = store.getSnapshot().modelsOverlay.roleRows.find((row) => row.role === 'slow');
        expect(slowRow?.assignment).toBeUndefined();
        expect(authStore.clearModelRoleMock).toHaveBeenCalledOnce();
        expect(authStore.clearModelRoleMock).toHaveBeenCalledWith('slow');
    });

    it('clearModelsOverlayRole does not touch other role assignments', async () => {
        const authStore = recordingAuthStore();
        const roleRows = createModelsOverlayRoleRows(
            { slow: selection('p1', 'm1'), vision: selection('p2', 'm2') },
            FALLBACK,
        );
        const store = createChatStore({ authStore });
        store.showModelsOverlay(ENTRIES, roleRows);

        await store.clearModelsOverlayRole('slow');

        const visionRow = store.getSnapshot().modelsOverlay.roleRows.find((row) => row.role === 'vision');
        expect(visionRow?.assignment).toEqual(selection('p2', 'm2'));
    });

    it('hideModelsOverlay deactivates the overlay and resets the mode', () => {
        const store = createChatStore();
        openOverlay(store);

        store.hideModelsOverlay();
        const snapshot = store.getSnapshot();
        expect(snapshot.modelsOverlay.active).toBe(false);
        expect(snapshot.overlayMode).toBe('none');
    });
});
