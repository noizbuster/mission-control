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
