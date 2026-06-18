/**
 * Interactive chat TUI driven by the ABG graph engine (the only engine — the flat loop was removed).
 * These tests prove the graph wiring renders the assistant output (via the `onSignal` delta tap +
 * the graph-durable-event renderer), that the DEFAULT (no `--engine`) drives the graph, and that an
 * active graph turn interrupts cleanly.
 *
 * The injected deterministic provider is bridged to the AI SDK (`wrapFlatProviderAsSdkModel`) on the
 * graph path — the same fixture the prior flat tests used, driven through the graph.
 */
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
import { replayedTypes } from './session-replay-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent — graph engine', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }

    it('drives an interactive turn through the graph by DEFAULT and renders the streamed assistant answer', async () => {
        const dataDir = await tempRoot('mctrl-chat-graph-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // No `--engine`: the graph is the interactive default now (the flip). Proven by the graph
        // boundary emit asserted below.
        const output = await runAgent(parseArgs(['--session', 'session_interactive_graph_text']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'answer in two words' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            // Concatenated deltas ('graph ok') equal the response content, so the assertion holds whether
            // the renderer streams via onSignal or renders the turn-completed payload.
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'graph ' },
                { kind: 'text_delta', delta: 'ok' },
                { kind: 'response_completed', content: 'graph ok' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Assistant: graph ok');
        // Graph provenance: the turn was driven by the graph (a boundary llm.turn.completed emit persisted).
        expect(events.some((event) => event.abg?.emit?.type === 'llm.turn.completed')).toBe(true);
    });

    it('interrupts an active graph turn', async () => {
        const dataDir = await tempRoot('mctrl-chat-graph-interrupt-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(
            parseArgs(['--session', 'session_interactive_graph_interrupt', '--engine', 'graph']),
            {
                authStore: createEmptyAuthStore(),
                chatInput: createScriptedChatInput([
                    { type: 'line', value: 'start a slow turn' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                ]),
                chatOutput: chatOutput.output,
                provider: createDeterministicProvider([
                    { kind: 'wait', ms: 30_000 },
                    { kind: 'response_completed', content: 'too late' },
                ]),
            },
        );

        expect(output).toContain('Interrupted active run');
        expect(output).not.toContain('too late');
        const types = await replayedTypes('session_interactive_graph_interrupt');
        expect(types).toEqual(expect.arrayContaining(['run.interrupted']));
        expect(types).not.toContain('run.completed');
    });
});
