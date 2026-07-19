import { createDeterministicProvider, type ProviderTurnRequest } from '@mission-control/core';
import { type AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import {
    fakeCommandExecutor,
    providerFromApprovedToolRequests,
    providerFromTurnRequests,
    providerThatAdaptsAfterDenial,
    writeFixtureFile,
} from './run-agent-interactive-coding-test-support';
import { replayedMessages } from './session-replay-test-support';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent UX', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('streams provider chunks and persists a durable final message for resumed sessions', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_stream']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'stream a provider turn' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'stream ' },
                { kind: 'text_delta', delta: 'chunk' },
                { kind: 'response_completed', content: 'stream final' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('resumed session: session_task20_stream');
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('Assistant: stream chunk');
        // The durable final message is the streamed assistant text. The graph persists the turn's
        // accumulated deltas ('stream chunk'); the deterministic fixture's response_completed content
        // ('stream final') deliberately differs from its deltas, so the streamed text is the
        // engine-stable value (a real provider's completed content equals its streamed text).
        expect(await replayedMessages('session_task20_stream')).toEqual(expect.arrayContaining(['stream chunk']));
    });

    it('blocks file.patch when approval is denied and leaves the workspace unchanged', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_deny']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'make a deterministic patch proposal' },
                { type: 'line', value: 'n' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerThatAdaptsAfterDenial(),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
            plainPromptGraph: 'coding-agent',
        });

        // Then
        // The tool-arg preview renders at proposal time (before the approval prompt), independent of
        // the approval outcome — so it appears even when the call is subsequently denied.
        expect(output).toContain('Patch preview for file.patch');
        expect(output).toContain('Approve file.patch? [once/always/deny]:');
        expect(output).toContain('Denied file.patch');
        // A denial surfaces the tool failure to the model; the run does NOT hard-fail on a single
        // denied tool. The provider adapts (text-only turn after seeing the denial) and the run
        // completes normally.
        expect(output).toContain('file.patch failed: approval_denied');
        expect(events.some((event) => event.type === 'task.failed')).toBe(false);
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.completed']));
        await expect(readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).rejects.toThrow();
    });

    it('applies approved patches and renders captured command output plainly', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_allow']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'make a deterministic patch proposal and run the test' },
                { type: 'line', value: 'y' },
                { type: 'line', value: 'y' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: fakeCommandExecutor,
            provider: providerFromApprovedToolRequests(requests),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
            plainPromptGraph: 'coding-agent',
        });

        // Then
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(output).toContain('Applied patch: .mctrl-task20.txt');
        // Gap A: the graph path renders a tool-arg PREVIEW for each proposal — parity with the flat
        // path's `renderToolPreview` (fired via `onToolCall` → `preflightInteractiveToolCall`). The
        // preview fires at proposal time through the awaited `onSignal` tap, so a user on the default
        // (graph) engine sees the same patch/command detail they would on the flat escape hatch.
        expect(output).toContain('Patch preview for file.patch');
        expect(output).toContain('Command preview for command.run');
        // Serialization proof: a multi-tool batch (file.patch + command.run proposed in ONE step)
        // presented each approval one at a time — neither was auto-denied by the approval broker's
        // single-pending invariant. This is the blocker the interactive-default flip had to close
        // (without serialized execution the 2nd concurrent approval would be denied and the run would
        // terminate before finalize).
        expect(output).toContain('Approved once file.patch');
        expect(output).not.toContain('another approval is already pending');
        expect(output).toContain('Command output for command.run');
        expect(output).toContain('stdout:\ntask20 ok');
        expect(output).toContain('Assistant: patch and test complete');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.completed']));
        expect(events.some((event) => event.type === 'run.blocked')).toBe(false);
        expect(await readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).toBe('approved\n');
    });

    it('continues after a read tool result and renders the final provider answer', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeFixtureFile(workspaceRoot, 'README.md', 'tool result from workspace\n');
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_continuation']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'read the readme and summarize it' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurnRequests(requests),
            plainPromptGraph: 'coding-agent',
        });

        // Then
        expect(requests).toHaveLength(2);
        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['read', 'ls', 'grep', 'find', 'file.edit', 'file.patch', 'command.run']),
        );
        // The exact `request.messages` array is engine-specific (the graph seeds its own ABG persona
        // `[system, …]`); the rendered final answer is the engine-agnostic continuation proof.
        expect(output).toContain('Assistant: final summary saw tool result from workspace');
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});
