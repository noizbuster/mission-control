import { createDeterministicProvider } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent approval hardening', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('does not resume a denied patch approval into execution', async () => {
        const dataDir = await tempRoot('mctrl-cli-denied-resume-data-');
        const workspaceRoot = await tempRoot('mctrl-cli-denied-resume-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const events: AgentEvent[] = [];
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_cli_denied_resume']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'patch then deny and try to resume' },
                { type: 'line', value: 'n' },
                { type: 'line', value: '/resume' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'call_cli_denied_resume',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({
                        patch: addFilePatch('.mission-control-cli-denied-resume.txt', 'must not write'),
                    }),
                },
                { kind: 'response_completed', content: 'approval required' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Denied file.patch');
        expect(output).toContain('Resume requested for session_cli_denied_resume');
        expect(events.map((event) => event.type)).not.toContain('file.diff.applied');
        await expect(readFile(join(workspaceRoot, '.mission-control-cli-denied-resume.txt'), 'utf8')).rejects.toThrow();
    });

    it('keeps repeated interrupts while blocked from applying pending effects', async () => {
        const dataDir = await tempRoot('mctrl-cli-blocked-interrupt-data-');
        const workspaceRoot = await tempRoot('mctrl-cli-blocked-interrupt-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const events: AgentEvent[] = [];
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_cli_blocked_interrupt']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'patch but interrupt at approval' },
                { type: 'interrupt' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'call_cli_blocked_interrupt',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({
                        patch: addFilePatch('.mission-control-cli-blocked-interrupt.txt', 'must not write'),
                    }),
                },
                { kind: 'response_completed', content: 'approval required' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Denied file.patch');
        expect(output).toContain('Run blocked: approval_denied: interrupted by user');
        expect(events.map((event) => event.type)).not.toContain('file.diff.applied');
        await expect(readFile(join(workspaceRoot, '.mission-control-cli-blocked-interrupt.txt'), 'utf8')).rejects.toThrow();
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}
