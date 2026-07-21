import { describe, expect, it } from 'vitest';
import type { AskUserQuestionRequest } from '../../tools/ask-user-schemas';
import { ASK_USER_BLOCKED_ANSWER } from '../../tools/ask-user-tool';
import { ToolRegistry } from '../../tools/tool-registry';
import type { ToolInvocationSettlement } from '../../tools/tool-registry-types';
import { type ChildHostCallbacks, registerChildAskUserTool } from './spawn-child';

describe('registerChildAskUserTool', () => {
    it('returns the blocked sentinel when no host surface is attached', async () => {
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-blocked', undefined);

        const settlement = await invokeAsk(registry, { question: 'pick one', options: [] });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({ answer: ASK_USER_BLOCKED_ANSWER });
    });

    it('forwards the question to hostCallbacks.requestUserQuestion when present', async () => {
        const calls: AskUserQuestionRequest[] = [];
        const hostCallbacks: ChildHostCallbacks = {
            requestUserQuestion: async (request) => {
                calls.push(request);
                return 'host-answered';
            },
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-forward', hostCallbacks);

        const settlement = await invokeAsk(registry, { question: 'which?', options: [] });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.question).toBe('which?');
        expect(calls[0]?.source?.sessionId).toBe('child-forward');
        expect(calls[0]?.header).toBe('From subagent');
        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({ answer: 'host-answered' });
    });

    it('stamps source metadata and parent-answers without hitting the user overlay', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const hostCallbacks: ChildHostCallbacks = {
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user';
            },
            parentAskUserAnswerer: {
                tryAnswer: async () => ({ kind: 'answer', answer: 'parent-ok' }),
            },
            resolveChildAskUserSource: () => ({ agentName: 'deep', title: 'Auth work' }),
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-parent', hostCallbacks);

        const settlement = await invokeAsk(registry, { question: 'which?', options: [] });

        expect(settlement.structuredOutput).toMatchObject({ answer: 'parent-ok' });
        expect(userCalls).toEqual([]);
    });

    it('escalates requires_user_confirmation to the user with a source header', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const hostCallbacks: ChildHostCallbacks = {
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user-confirmed';
            },
            parentAskUserAnswerer: {
                tryAnswer: async () => ({ kind: 'answer', answer: 'should-not-run' }),
            },
            resolveChildAskUserSource: () => ({ agentName: 'deep' }),
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-confirm', hostCallbacks);

        const settlement = await invokeAsk(registry, {
            question: 'Approve deploy?',
            options: [],
            requires_user_confirmation: true,
        });

        expect(settlement.structuredOutput).toMatchObject({ answer: 'user-confirmed' });
        expect(userCalls).toHaveLength(1);
        expect(userCalls[0]?.header).toBe('From subagent deep');
        expect(userCalls[0]?.requiresUserConfirmation).toBe(true);
    });

    it('serializes concurrent ask_user invocations under a per-spawn mutex', async () => {
        let active = 0;
        let maxActive = 0;
        const hostCallbacks: ChildHostCallbacks = {
            requestUserQuestion: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => {
                    setTimeout(resolve, 20);
                });
                active -= 1;
                return 'ok';
            },
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-mutex', hostCallbacks);

        await Promise.all([
            invokeAsk(registry, { question: 'one', options: [] }),
            invokeAsk(registry, { question: 'two', options: [] }),
            invokeAsk(registry, { question: 'three', options: [] }),
        ]);

        // The mutex must guarantee that the host callback never sees more than one concurrent
        // call — otherwise the parent TUI's single overlay slot would race.
        expect(maxActive).toBe(1);
    });

    it('keeps the chain usable after a rejected host callback (lock does not wedge)', async () => {
        let first = true;
        const hostCallbacks: ChildHostCallbacks = {
            requestUserQuestion: async () => {
                if (first) {
                    first = false;
                    throw new Error('overlay dismissed');
                }
                return 'second-ok';
            },
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-recover', hostCallbacks);

        const firstSettlement = await invokeAsk(registry, { question: 'first', options: [] }).catch(
            (error: unknown) => error,
        );
        // The first call rejects; the second must still resolve normally because the mutex
        // swallows the rejection so subsequent asks are not stuck waiting on a dead lock.
        expect(firstSettlement).toBeInstanceOf(Error);
        const secondSettlement = await invokeAsk(registry, { question: 'second', options: [] });
        expect(secondSettlement.result.status).toBe('completed');
        expect(secondSettlement.structuredOutput).toMatchObject({ answer: 'second-ok' });
    });

    it('emits a blocked event when no host surface is attached but emitEvent is provided', async () => {
        const events: unknown[] = [];
        const hostCallbacks: ChildHostCallbacks = {
            emitEvent: (event) => {
                events.push(event);
            },
        };
        const registry = new ToolRegistry();
        registerChildAskUserTool(registry, 'child-emit', hostCallbacks);

        await invokeAsk(registry, { question: 'blocked?', options: [] });

        expect(events).toHaveLength(1);
    });
});

async function invokeAsk(
    registry: ToolRegistry,
    input: {
        readonly question: string;
        readonly options?: readonly unknown[];
        readonly requires_user_confirmation?: boolean;
    },
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'ask_user');
    if (advertisement === undefined) {
        throw new TypeError('ask_user advertisement missing');
    }
    return registry.invoke({
        toolCallId: 'ask_call',
        toolName: 'ask_user',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}
