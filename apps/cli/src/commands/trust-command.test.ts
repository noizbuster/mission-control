import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createHelpText } from '../index.js';
import { parseChatLine } from './chat-commands.js';
import { runTrustAction } from './interactive-chat-trust.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('interactive trust command', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('parses trust status deny and reset slash commands', () => {
        // Given / When / Then
        expect(parseChatLine('/trust')).toEqual({ kind: 'trust', action: 'trust' });
        expect(parseChatLine('/trust status')).toEqual({ kind: 'trust', action: 'status' });
        expect(parseChatLine('/trust deny')).toEqual({ kind: 'trust', action: 'deny' });
        expect(parseChatLine('/trust reset')).toEqual({ kind: 'trust', action: 'reset' });
        expect(parseChatLine('/trust allow')).toEqual({
            kind: 'invalid',
            message: '/trust supports: status, deny, reset',
        });
    });

    it('shows trust commands in CLI help', () => {
        // Given / When
        const help = createHelpText();

        // Then
        expect(help).toContain('/trust');
        expect(help).toContain('/trust status');
        expect(help).toContain('/trust deny');
        expect(help).toContain('/trust reset');
    });

    it('drives status trust deny and reset through the interactive CLI action surface', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-trust-data-');
        const workspaceRoot = await tempRoot('mctrl-trust-workspace-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/trust status' },
                { type: 'line', value: '/trust' },
                { type: 'line', value: '/trust status' },
                { type: 'line', value: '/trust deny' },
                { type: 'line', value: '/trust reset' },
                { type: 'line', value: '/trust status' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
        });

        // Then
        expect(output).toContain(`Trust status for ${workspaceRoot}: unknown`);
        expect(output).toContain(`Trusted project: ${workspaceRoot}`);
        expect(output).toContain(`Trust status for ${workspaceRoot}: trusted`);
        expect(output).toContain(`Denied project: ${workspaceRoot}`);
        expect(output).toContain(`Reset project trust: ${workspaceRoot}`);
        expect(output).toContain(`Trust status for ${workspaceRoot}: unknown`);
        await expect(readFile(join(workspaceRoot, 'trust', 'projects.json'), 'utf8')).rejects.toThrow();
        expect(await readFile(join(dataDir, 'trust', 'projects.json'), 'utf8')).not.toContain('unknown');
    });

    it('prints recoverable trust command errors', async () => {
        // Given
        const chatOutput = createBufferedChatOutput();

        // When
        await runTrustAction(chatOutput.output, 'status', join(tmpdir(), 'mctrl-missing-workspace'));

        // Then
        expect(chatOutput.getOutput()).toContain('Trust command failed:');
    });

    async function tempRoot(prefix: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        return root;
    }
});
