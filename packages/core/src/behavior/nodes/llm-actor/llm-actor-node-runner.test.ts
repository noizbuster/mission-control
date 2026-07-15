// allow: SIZE_OK -- HEAD 939 -> current 943 pure LOC; one LLM actor node state-machine matrix spanning stream and tool settlements.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Blackboard, createBlackboard } from '../../../memory/blackboard';
import * as skillLoaderModule from '../../../skills/skill-loader';
import { ToolRegistry } from '../../../tools/tool-registry';
import type { AbgNodeRunContext } from '../../node-registry';
import { runLlmActorNode } from './llm-actor-node-runner';
import { _testResetSkillCache, bustSkillCache } from './llm-actor-skill-cache';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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

    it('does not substitute outputDefault for out-of-enum prose', async () => {
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

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('intent.classification')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
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

    it('does not substitute outputDefault true for a boolean gate when the model returns prose', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_bool_default_true',
            now: () => NOW,
            sdkModel: modelReturning('Let me find the actual implementation files.'),
            blackboard,
        };
        const node = {
            id: 'guard',
            kind: 'llm',
            config: {
                outputKey: 'guard.cleared',
                outputShape: 'boolean',
                outputDefault: 'true',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('guard.cleared')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('does not substitute outputDefault false for a boolean gate when parsing fails', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_bool_default_false',
            now: () => NOW,
            sdkModel: modelReturning('I cannot determine the answer right now.'),
            blackboard,
        };
        const node = {
            id: 'evidence',
            kind: 'llm',
            config: {
                outputKey: 'evidence.verified',
                outputShape: 'boolean',
                outputDefault: 'false',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('evidence.verified')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('fails closed for a boolean gate with no outputDefault when parsing fails', async () => {
        // Without outputDefault, free-text must not write false and dead-end the graph
        // (research-complete requires true). Fail so the node can retry.
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_bool_no_default',
            now: () => NOW,
            sdkModel: modelReturning('Some prose without a boolean.'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'explore.complete',
                outputShape: 'boolean',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('explore.complete')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('does not default an array node to empty when parsing fails', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_array_no_default',
            now: () => NOW,
            sdkModel: modelReturning('I need to look at the files first.'),
            blackboard,
        };
        const node = {
            id: 'todo-plan',
            kind: 'llm',
            config: {
                outputKey: 'plan.todos',
                outputShape: 'array',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('plan.todos')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('fails closed for an object node with no outputDefault when parsing fails', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_object_no_default',
            now: () => NOW,
            sdkModel: modelReturning('not an object'),
            blackboard,
        };
        const node = {
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'some.object',
                outputShape: 'object',
            },
        } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('some.object')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    it('does not write true for no-text turns', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_empty',
            now: () => NOW,
            sdkModel: modelReturning(''),
            blackboard,
        };
        const node = { id: 'wave', kind: 'llm', config: { outputKey: 'wave.complete' } } as const;

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('wave.complete')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
    });

    function registryWithProbe(): ToolRegistry {
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
        return registry;
    }

    function modelWithToolCall(text: string | null): MockLanguageModelV3 {
        const chunks: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (text !== null) {
            chunks.push(
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: text },
                { type: 'text-end', id: 't1' },
            );
        }
        chunks.push(
            { type: 'tool-input-start', id: 'call_probe', toolName: 'probe' },
            { type: 'tool-input-delta', id: 'call_probe', delta: '{}' },
            { type: 'tool-input-end', id: 'call_probe' },
            { type: 'tool-call', toolCallId: 'call_probe', toolName: 'probe', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
        );
        return new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock-tool-call',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        });
    }

    it('does not write outputKey and keeps loop_active for tool call + empty text', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_tool_empty',
            now: () => NOW,
            sdkModel: modelWithToolCall(''),
            blackboard,
            toolRegistry: registryWithProbe(),
        };
        const node = {
            id: 'research-explore',
            kind: 'llm' as const,
            capabilities: ['read'],
            config: { outputKey: 'explore.complete', outputShape: 'boolean' },
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('explore.complete')).toBe(false);
        expect(blackboard.get('llm.loop_active')).toBe(true);
    });

    it('does not complete on free prose with a tool call when outputShape is boolean', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_tool_prose',
            now: () => NOW,
            sdkModel: modelWithToolCall("I'll explore the codebase next."),
            blackboard,
            toolRegistry: registryWithProbe(),
        };
        const node = {
            id: 'research-explore',
            kind: 'llm' as const,
            capabilities: ['read'],
            config: { outputKey: 'explore.complete', outputShape: 'boolean' },
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('explore.complete')).toBe(false);
        expect(blackboard.get('llm.loop_active')).toBe(true);
    });

    it('rejects explore.complete when true appears only on the last line', async () => {
        const blackboard = seedBlackboard();
        const context: AbgNodeRunContext = {
            graphId: 'g_bool_true_complete',
            now: () => NOW,
            sdkModel: modelReturning('Here is the grounded synthesis.\ntrue'),
            blackboard,
        };
        const node = {
            id: 'research-explore',
            kind: 'llm' as const,
            config: { outputKey: 'explore.complete', outputShape: 'boolean' },
        };

        const signals = await collectSignals(runLlmActorNode(node, context));

        expect(blackboard.has('explore.complete')).toBe(false);
        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
        expect(blackboard.get('llm.loop_active')).toBe(false);
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

describe('runLlmActorNode — capabilities-based tool suppression', () => {
    function registryWithReadTool(): ToolRegistry {
        const registry = new ToolRegistry();
        registry.register({
            name: 'read',
            description: 'read a file',
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
        return registry;
    }

    it('suppresses all tools when capabilities is explicitly empty', async () => {
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'summarize' }] as readonly ModelMessage[]);
        const model = buildModel();
        const context: AbgNodeRunContext = {
            graphId: 'g_no_caps',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registryWithReadTool(),
        };
        const node = {
            id: 'final-respond',
            kind: 'llm' as const,
            capabilities: [],
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(model.doStreamCalls.length).toBe(1);
        const call = model.doStreamCalls[0];
        expect(call?.tools).toBeUndefined();
    });

    it('advertises tools when capabilities is absent and no outputKey', async () => {
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'summarize' }] as readonly ModelMessage[]);
        const model = buildModel();
        const context: AbgNodeRunContext = {
            graphId: 'g_inherit_caps',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registryWithReadTool(),
        };
        const node = {
            id: 'final-respond',
            kind: 'llm' as const,
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(model.doStreamCalls.length).toBe(1);
        const call = model.doStreamCalls[0];
        expect(call?.tools).toBeDefined();
        expect(call?.tools?.length).toBeGreaterThan(0);
    });

    it('filters tools to only matching capability classes when capabilities is non-empty', async () => {
        const registry = new ToolRegistry();
        registry.register({
            name: 'read',
            description: 'read a file',
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
        registry.register({
            name: 'task',
            description: 'delegate a sub-task',
            capabilityClasses: ['subagent'],
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
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'delegate work' }] as readonly ModelMessage[]);
        const model = buildModel();
        const context: AbgNodeRunContext = {
            graphId: 'g_filtered_caps',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registry,
        };
        const node = {
            id: 'delegate-worker',
            kind: 'llm' as const,
            capabilities: ['subagent'],
        };

        await collectSignals(runLlmActorNode(node, context));

        expect(model.doStreamCalls.length).toBe(1);
        const call = model.doStreamCalls[0];
        expect(call?.tools).toBeDefined();
        expect(call?.tools?.length).toBe(1);
    });
});

describe('runLlmActorNode — skill discovery session cache', () => {
    const node = { id: 'llm-actor', kind: 'llm' } as const;

    let tempRoot: string;
    let workspace: string;
    let skillPath: string;
    let previousConfigDir: string | undefined;

    async function runTurn(blackboard: Blackboard): Promise<void> {
        const model = buildModel();
        blackboard.appendMessages([{ role: 'user', content: 'ping' }] as readonly ModelMessage[]);
        const context: AbgNodeRunContext = {
            graphId: 'g-cache',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            systemPromptEnv: { cwd: workspace, workspaceRoot: workspace },
        };
        await collectSignals(runLlmActorNode(node, context));
    }

    beforeEach(async () => {
        _testResetSkillCache();
        tempRoot = await mkdtemp(join(tmpdir(), 'runner-skill-cache-'));
        workspace = join(tempRoot, 'workspace');
        const skillDir = join(workspace, '.agents', 'skills', 'cached-skill');
        await mkdir(skillDir, { recursive: true });
        skillPath = join(skillDir, 'SKILL.md');
        await writeFile(
            skillPath,
            '---\nname: cached-skill\ndescription: A skill for cache testing.\n---\nBody.',
            'utf8',
        );
        previousConfigDir = process.env['MCTRL_CONFIG_DIR'];
        process.env['MCTRL_CONFIG_DIR'] = join(tempRoot, 'empty-global-config');
    });

    afterEach(async () => {
        if (previousConfigDir !== undefined) {
            process.env['MCTRL_CONFIG_DIR'] = previousConfigDir;
        } else {
            delete process.env['MCTRL_CONFIG_DIR'];
        }
        await rm(tempRoot, { recursive: true, force: true });
    });

    it('calls discoverSkills once across 5 turns sharing one blackboard', async () => {
        const spy = vi.spyOn(skillLoaderModule, 'discoverSkills');
        try {
            const blackboard = createBlackboard();
            for (let turn = 0; turn < 5; turn++) {
                await runTurn(blackboard);
            }
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('re-discovers when a SKILL.md mtime changes', async () => {
        const spy = vi.spyOn(skillLoaderModule, 'discoverSkills');
        try {
            const blackboard = createBlackboard();
            for (let turn = 0; turn < 5; turn++) {
                await runTurn(blackboard);
            }
            expect(spy).toHaveBeenCalledTimes(1);

            const futureMtime = Math.floor(Date.now() / 1000) + 500;
            await utimes(skillPath, futureMtime, futureMtime);

            await runTurn(blackboard);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('starts cold for a new blackboard with the same workspaceRoot', async () => {
        const spy = vi.spyOn(skillLoaderModule, 'discoverSkills');
        try {
            const blackboardA = createBlackboard();
            for (let turn = 0; turn < 3; turn++) {
                await runTurn(blackboardA);
            }
            expect(spy).toHaveBeenCalledTimes(1);

            const blackboardB = createBlackboard();
            await runTurn(blackboardB);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('re-discovers after bustSkillCache() clears the cache', async () => {
        const spy = vi.spyOn(skillLoaderModule, 'discoverSkills');
        try {
            const blackboard = createBlackboard();
            for (let turn = 0; turn < 3; turn++) {
                await runTurn(blackboard);
            }
            expect(spy).toHaveBeenCalledTimes(1);

            bustSkillCache();

            await runTurn(blackboard);
            expect(spy).toHaveBeenCalledTimes(2);

            for (let turn = 0; turn < 3; turn++) {
                await runTurn(blackboard);
            }
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });
});
