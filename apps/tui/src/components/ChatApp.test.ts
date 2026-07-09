import { describe, expect, it, vi } from 'vitest';

vi.mock('@mission-control/tui', async () => await import('../terminal-text.js'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat.js'));
vi.mock('@mission-control/core', () => ({
    ContinuationRuntime: class ContinuationRuntime {},
    MAIN_AGENT_ID: 'main',
    readBoulder: () => undefined,
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));

/**
 * Re-export smoke only. Multi-file topology pins live in
 * `chat-app/chat-app-topology.test.ts`.
 */
describe('ChatApp public re-export surface', () => {
    it('re-exports pure helpers from chat-app-helpers', async () => {
        const chatApp = await import('./ChatApp.js');
        const helpers = await import('./chat-app/chat-app-helpers.js');

        expect(chatApp.deriveStatusBarProps).toBe(helpers.deriveStatusBarProps);
        expect(chatApp.preserveBlockReferences).toBe(helpers.preserveBlockReferences);
        expect(chatApp.promptPanelRepaintKey).toBe(helpers.promptPanelRepaintKey);
        expect(chatApp.parseModelPreferenceKeys).toBe(helpers.parseModelPreferenceKeys);
        expect(chatApp.recentModelPreferenceSelections).toBe(helpers.recentModelPreferenceSelections);
        expect(typeof chatApp.ChatApp).toBe('function');
    });
});
