/**
 * Regression test for the coding-agent "acts like a chatbot" failure mode.
 *
 * `runLlmActorNode` must thread `context.systemPromptEnv` and `context.projectInstructionResources`
 * into the assembled system prompt. Without env, the model has no awareness of cwd/workspace/git/date;
 * without resources, AGENTS.md/CLAUDE.md never reach the model. Both gaps cause the agent to answer
 * generically instead of acting on the workspace. This test pins the contract by capturing the
 * system message the AI SDK actually receives via `MockLanguageModelV3.doStreamCalls`.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBlackboard } from '../../../memory/blackboard.js';
import { ToolRegistry } from '../../../tools/tool-registry.js';
import type { AbgNodeRunContext } from '../../node-registry.js';
import { runLlmActorNode } from './llm-actor-node-runner.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-06-19T00:00:00.000Z';

function buildUsage() {
    return {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ok' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
    ];
}

function buildModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: 'anthropic',
        modelId: 'claude-fable-5',
        doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
    });
}

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

/** Pull the system prompt text the model received from a recorded `doStream` call. */
function capturedSystemText(calls: readonly { readonly prompt: readonly unknown[] }[]): string | undefined {
    const prompt = calls[0]?.prompt;
    if (prompt === undefined) {
        return undefined;
    }
    for (const message of prompt) {
        if (
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            (message as { role: string }).role === 'system'
        ) {
            const content = (message as { content?: unknown }).content;
            if (Array.isArray(content)) {
                return content
                    .map((part) =>
                        typeof part === 'object' &&
                        part !== null &&
                        'text' in part &&
                        typeof (part as { text?: unknown }).text === 'string'
                            ? (part as { text: string }).text
                            : '',
                    )
                    .join('\n');
            }
            if (typeof content === 'string') {
                return content;
            }
        }
    }
    return undefined;
}

describe('runLlmActorNode — system prompt threading', () => {
    const node = { id: 'llm-actor', kind: 'llm' } as const;

    it('includes the environment block and project instructions when context provides them', async () => {
        const model = buildModel();
        const blackboard = createBlackboard();
        const messages: ModelMessage[] = [{ role: 'user', content: 'ping' }];
        blackboard.appendMessages(messages);

        const context: AbgNodeRunContext = {
            graphId: 'g_threading',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            systemPromptEnv: {
                cwd: '/home/user/projects/demo',
                workspaceRoot: '/home/user/projects/demo',
                gitEnabled: true,
                platform: 'linux',
                date: '2026-06-19',
                modelId: 'claude-fable-5',
            },
            projectInstructionResources: [
                { path: 'AGENTS.md', content: 'Always use pnpm test.' },
                { path: 'CLAUDE.md', content: 'No unsafe casts.' },
            ],
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(model.doStreamCalls.length).toBe(1);
        const system = capturedSystemText(model.doStreamCalls);
        expect(system).toBeDefined();
        expect(system).toContain('Working directory: /home/user/projects/demo');
        expect(system).toContain('Git: yes');
        expect(system).toContain('Date: 2026-06-19');
        expect(system).toContain('Model: claude-fable-5');
        expect(system).toContain('--- AGENTS.md ---');
        expect(system).toContain('Always use pnpm test.');
        expect(system).toContain('--- CLAUDE.md ---');
        expect(system).toContain('No unsafe casts.');
    });

    it('omits the environment block and project instructions when context does not provide them', async () => {
        const model = buildModel();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'ping' } as ModelMessage]);

        const context: AbgNodeRunContext = {
            graphId: 'g_absent',
            now: () => NOW,
            sdkModel: model,
            blackboard,
        };

        await collectSignals(runLlmActorNode(node, context));

        const system = capturedSystemText(model.doStreamCalls);
        expect(system).toBeDefined();
        // The persona + tool-usage policy is still present, but the environment block and project
        // instructions section must NOT appear when context omits them.
        expect(system).not.toContain('# Environment');
        expect(system).not.toContain('# Project instructions');
        expect(system).not.toContain('--- AGENTS.md ---');
    });

    it('honors an explicit node systemPrompt config over the assembled prompt', async () => {
        const model = buildModel();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'ping' } as ModelMessage]);

        const context: AbgNodeRunContext = {
            graphId: 'g_override',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            systemPromptEnv: { cwd: '/should-not-appear' },
        };
        const nodeWithOverride = {
            id: 'llm-actor',
            kind: 'llm',
            config: { systemPrompt: 'OVERRIDE_PERSONA' },
        } as const;

        await collectSignals(runLlmActorNode(nodeWithOverride, context));

        const system = capturedSystemText(model.doStreamCalls);
        expect(system).toBe('OVERRIDE_PERSONA');
        expect(system).not.toContain('/should-not-appear');
    });

    it('surfaces a registered tool guideline in the # Guidelines section of the prompt', async () => {
        const model = buildModel();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'ping' } as ModelMessage]);

        const registry = new ToolRegistry();
        registry.register({
            name: 'guided.tool',
            description: 'a tool with a usage hint',
            capabilityClasses: ['read'],
            parametersJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.boolean() }),
            outputLimit: { maxModelOutputChars: 32 },
            guideline: 'prefer edit over write',
            execute: async () => ({ ok: true }),
        });

        const context: AbgNodeRunContext = {
            graphId: 'g_guideline',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registry,
        };

        await collectSignals(runLlmActorNode(node, context));

        const system = capturedSystemText(model.doStreamCalls);
        expect(system).toContain('# Guidelines');
        expect(system).toContain('prefer edit over write');
    });

    it('omits the # Guidelines section when no registered tool carries a guideline', async () => {
        const model = buildModel();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'ping' } as ModelMessage]);

        const registry = new ToolRegistry();
        registry.register({
            name: 'plain.tool',
            description: 'a tool without a usage hint',
            capabilityClasses: ['read'],
            parametersJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.boolean() }),
            outputLimit: { maxModelOutputChars: 32 },
            execute: async () => ({ ok: true }),
        });

        const context: AbgNodeRunContext = {
            graphId: 'g_no_guideline',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registry,
        };

        await collectSignals(runLlmActorNode(node, context));

        const system = capturedSystemText(model.doStreamCalls);
        expect(system).not.toContain('# Guidelines');
    });

    it('lists discovered skills in <available_skills> but does not inject their bodies', async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), 'runner-skills-'));
        const previousConfigDir = process.env['MCTRL_CONFIG_DIR'];
        process.env['MCTRL_CONFIG_DIR'] = join(tempRoot, 'empty-global-config');
        try {
            const workspace = join(tempRoot, 'workspace');
            const skillDir = join(workspace, '.agents', 'skills', 'fixture-skill');
            await mkdir(skillDir, { recursive: true });
            const bodyMarker = 'UNIQUE_SKILL_BODY_MARKER_9f8e7d6c5b';
            await writeFile(
                join(skillDir, 'SKILL.md'),
                `---\nname: fixture-skill\ndescription: A fixture skill for testing.\n---\n${bodyMarker}\nDetailed instructions.`,
                'utf8',
            );

            const model = buildModel();
            const blackboard = createBlackboard();
            blackboard.appendMessages([{ role: 'user', content: 'ping' }] as readonly ModelMessage[]);

            const context: AbgNodeRunContext = {
                graphId: 'g_skills',
                now: () => NOW,
                sdkModel: model,
                blackboard,
                systemPromptEnv: {
                    cwd: workspace,
                    workspaceRoot: workspace,
                },
            };

            await collectSignals(runLlmActorNode(node, context));

            const system = capturedSystemText(model.doStreamCalls);
            expect(system).toBeDefined();
            expect(system).toContain('<available_skills>');
            expect(system).toContain('<name>fixture-skill</name>');
            expect(system).toContain('<description>A fixture skill for testing.</description>');
            expect(system).toContain('fixture-skill/SKILL.md');
            expect(system).not.toContain(bodyMarker);
        } finally {
            if (previousConfigDir !== undefined) {
                process.env['MCTRL_CONFIG_DIR'] = previousConfigDir;
            } else {
                delete process.env['MCTRL_CONFIG_DIR'];
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('runLlmActorNode — outputKey structured-output persistence', () => {
    function textChunks(text: string): LanguageModelV3StreamPart[] {
        return [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: text },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
        ];
    }

    function modelReturning(text: string): MockLanguageModelV3 {
        return new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock-output',
            doStream: async () => ({ stream: convertArrayToReadableStream(textChunks(text)) }),
        });
    }

    function seedBlackboard(): ReturnType<typeof createBlackboard> {
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'ping' }] as readonly ModelMessage[]);
        return blackboard;
    }

    it('persists a bare JSON object to the declared outputKey', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_obj',
            now: () => NOW,
            sdkModel: modelReturning('{"class":"explicit"}'),
            blackboard,
        };
        const node = { id: 'gate', kind: 'llm', config: { outputKey: 'intent.classification' } } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('intent.classification')).toEqual({ class: 'explicit' });
    });

    it('persists a json-fenced array to the declared outputKey', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_fenced',
            now: () => NOW,
            sdkModel: modelReturning('```json\n[{"task":"a"},{"task":"b"}]\n```'),
            blackboard,
        };
        const node = { id: 'planner', kind: 'llm', config: { outputKey: 'wave.tasks' } } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('wave.tasks')).toEqual([{ task: 'a' }, { task: 'b' }]);
    });

    it('persists a plain boolean string as a real boolean', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_bool',
            now: () => NOW,
            sdkModel: modelReturning('true'),
            blackboard,
        };
        const node = { id: 'verify', kind: 'llm', config: { outputKey: 'verify.complete' } } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('verify.complete')).toBe(true);
    });

    it('persists a plain single-line string (backwards compat)', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_str',
            now: () => NOW,
            sdkModel: modelReturning('explicit'),
            blackboard,
        };
        const node = { id: 'gate', kind: 'llm', config: { outputKey: 'intent.classification' } } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('intent.classification')).toBe('explicit');
    });

    it('fails closed on invalid structured output without writing the blackboard', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_fail',
            now: () => NOW,
            sdkModel: modelReturning('{"class":"explicit"'),
            blackboard,
        };
        const node = { id: 'gate', kind: 'llm', config: { outputKey: 'intent.classification' } } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('intent.classification')).toBe(false);
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toBeDefined();
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'invalid_structured_output' } });
    });

    it('fails closed when outputShape does not match the parsed value', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_shape',
            now: () => NOW,
            sdkModel: modelReturning('hello'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: { outputKey: 'intent.classification', outputShape: 'object' },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('intent.classification')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('persists an in-enum outputKey value unchanged', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_enum_ok',
            now: () => NOW,
            sdkModel: modelReturning('exploratory-research'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'intent.classification',
                outputEnum: ['trivial', 'exploratory-research', 'ambiguous'],
            },
        } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('intent.classification')).toBe('exploratory-research');
    });

    it('substitutes outputDefault when the parsed value is out-of-enum prose', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_enum_default',
            now: () => NOW,
            sdkModel: modelReturning('I will check the files and then report back.'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'intent.classification',
                outputEnum: ['trivial', 'exploratory-research', 'ambiguous'],
                outputDefault: 'ambiguous',
            },
        } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('intent.classification')).toBe('ambiguous');
    });

    it('fails closed when an out-of-enum value has no outputDefault', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_enum_no_default',
            now: () => NOW,
            sdkModel: modelReturning('not a real class'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'intent.classification',
                outputEnum: ['trivial', 'exploratory-research', 'ambiguous'],
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('intent.classification')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('fails closed when outputDefault is itself out-of-enum', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_enum_bad_default',
            now: () => NOW,
            sdkModel: modelReturning('garbage prose'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'intent.classification',
                outputEnum: ['trivial', 'exploratory-research'],
                outputDefault: 'not-in-enum',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('intent.classification')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('writes true for no-text turns (completion signal backwards compat)', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_empty',
            now: () => NOW,
            sdkModel: modelReturning(''),
            blackboard,
        };
        const node = { id: 'wave', kind: 'llm', config: { outputKey: 'wave.complete' } } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.get('wave.complete')).toBe(true);
    });

    it('leaves the blackboard untouched for nodes without an outputKey', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_nokey',
            now: () => NOW,
            sdkModel: modelReturning('{"k":1}'),
            blackboard,
        };
        const node = { id: 'plain', kind: 'llm' } as const;

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('llm.loop_active')).toBe(true);
        const nonLoopEntries = blackboard.listEntries().filter((entry) => entry.key !== 'llm.loop_active');
        expect(nonLoopEntries).toEqual([]);
    });

    it('persists outputKey and clears loopActive when text parses ALONGSIDE a tool call', async () => {
        // Regression: previously outputKey was only persisted when `!loopActive`, so a model
        // that called tools AND emitted its structured output in one turn would spin forever
        // on the llm-loop-active self-edge. Now a successful parse clears loopActive.
        const registry = new ToolRegistry();
        registry.register({
            name: 'probe',
            description: 'read-only probe',
            capabilityClasses: ['read'],
            parametersJsonSchema: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
            },
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.boolean() }),
            outputLimit: { maxModelOutputChars: 32 },
            execute: async () => ({ ok: true }),
        });

        const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: '{"classification":"disciplined"}' },
            { type: 'text-end', id: 't1' },
            { type: 'tool-input-start', id: 'call_probe', toolName: 'probe' },
            { type: 'tool-input-delta', id: 'call_probe', delta: '{}' },
            { type: 'tool-input-end', id: 'call_probe' },
            { type: 'tool-call', toolCallId: 'call_probe', toolName: 'probe', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
        ];
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock-tool-and-text',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        });

        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_tool_plus_output',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registry,
        };
        const node = {
            id: 'maturity-check',
            kind: 'llm' as const,
            capabilities: ['read'],
            config: { outputKey: 'explore.maturity' },
        };

        await collectSignals(runLlmActorNode(node, context));

        // The structured output was parsed and persisted even though the turn also called a tool.
        expect(blackboard.get('explore.maturity')).toEqual({ classification: 'disciplined' });
        // loopActive was cleared so the llm-loop-active self-edge does NOT fire and the graph
        // advances to the next node.
        expect(blackboard.get('llm.loop_active')).toBe(false);
    });
});
