import type { ProviderTurnRequest } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { captureSequentialProvider, seedCompactedSession, tempRoot } from './compact-command-test-support.js';
import { runAgent } from './run-agent.js';
import { createEmptyAuthStore } from './run-agent-chat-test-support.js';
import { rm } from 'node:fs/promises';

describe('runAgent owner prompt compaction replay', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('uses compaction-aware default replay for noninteractive prompts', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-owner-compaction-');
        const sessionId = 'session_owner_prompt_compaction';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedCompactedSession(dataDir, sessionId);
        const requests: ProviderTurnRequest[] = [];

        await runAgent(parseArgs(['--no-tui', '--session', sessionId, 'NEW_PROMPT']), {
            authStore: createEmptyAuthStore(),
            provider: captureSequentialProvider(requests, ['owner prompt continued']),
        });

        expect(requests).toHaveLength(1);
        // Engine-agnostic: the flat loop seeds exactly [summary, second task, second result,
        // NEW_PROMPT] as user/assistant messages; the graph engine prepends a coding-agent system
        // prompt and may reshape the compaction summary's role. The intent — the compaction
        // summary AND the seeded compacted conversation reach the model — is captured by checking
        // each is present in the request's messages.
        const messageBlobs = (requests[0]?.messages ?? []).map((message) => JSON.stringify(message));
        const expectedVisible = [
            'COMPACTION_SUMMARY_SHOULD_BE_VISIBLE',
            'second task',
            'second result',
            'NEW_PROMPT',
        ];
        for (const expected of expectedVisible) {
            expect(messageBlobs.some((blob) => blob.includes(expected))).toBe(true);
        }
    });
});
