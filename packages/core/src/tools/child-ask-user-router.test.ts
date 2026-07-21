import { describe, expect, it, vi } from 'vitest';
import type { AskUserQuestionRequest } from './ask-user-schemas';
import {
    type ChildAskUserParentAnswerer,
    formatChildAskUserHeader,
    routeChildAskUser,
    withChildAskUserSource,
} from './child-ask-user-router';

function baseRequest(overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest {
    return {
        question: 'Ship it?',
        options: ['yes', 'no'],
        ...overrides,
    };
}

describe('withChildAskUserSource', () => {
    it('stamps source without mutating the original request', () => {
        const request = baseRequest({ header: 'Confirm' });
        const stamped = withChildAskUserSource(request, {
            sessionId: 'child-1',
            agentName: 'deep',
            title: 'Investigate auth',
        });

        expect(request).not.toHaveProperty('source');
        expect(stamped.source).toEqual({
            sessionId: 'child-1',
            agentName: 'deep',
            title: 'Investigate auth',
        });
        expect(stamped.header).toBe('Confirm');
    });
});

describe('formatChildAskUserHeader', () => {
    it('formats agent name only', () => {
        const header = formatChildAskUserHeader(
            baseRequest({
                source: { sessionId: 'c1', agentName: 'deep' },
            }),
        );
        expect(header).toBe('From subagent deep');
    });

    it('formats agent name with title', () => {
        const header = formatChildAskUserHeader(
            baseRequest({
                source: { sessionId: 'c1', agentName: 'deep', title: 'Investigate auth' },
            }),
        );
        expect(header).toBe('From subagent deep: Investigate auth');
    });

    it('merges with an existing header', () => {
        const header = formatChildAskUserHeader(
            baseRequest({
                header: 'Theme',
                source: { sessionId: 'c1', agentName: 'explore' },
            }),
        );
        expect(header).toBe('From subagent explore — Theme');
    });

    it('falls back to category when agent name is absent', () => {
        const header = formatChildAskUserHeader(
            baseRequest({
                source: { sessionId: 'c1', category: 'librarian' },
            }),
        );
        expect(header).toBe('From subagent librarian');
    });
});

describe('routeChildAskUser', () => {
    it('forces user overlay when requiresUserConfirmation is true', async () => {
        const tryAnswer = vi.fn(async () => ({ kind: 'answer' as const, answer: 'parent-yes' }));
        const parentAnswerer: ChildAskUserParentAnswerer = { tryAnswer };
        const userCalls: AskUserQuestionRequest[] = [];

        const answer = await routeChildAskUser({
            request: baseRequest({
                requiresUserConfirmation: true,
                source: { sessionId: 'c1', agentName: 'deep' },
            }),
            parentAnswerer,
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user-yes';
            },
        });

        expect(answer).toBe('user-yes');
        expect(tryAnswer).not.toHaveBeenCalled();
        expect(userCalls).toHaveLength(1);
        expect(userCalls[0]?.header).toBe('From subagent deep');
    });

    it('short-circuits when the parent answers', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const answer = await routeChildAskUser({
            request: baseRequest({ source: { sessionId: 'c1', agentName: 'deep' } }),
            parentAnswerer: {
                tryAnswer: async () => ({ kind: 'answer', answer: 'parent-decided' }),
            },
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user';
            },
        });

        expect(answer).toBe('parent-decided');
        expect(userCalls).toEqual([]);
    });

    it('escalates to the user when the parent returns needs_user', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const answer = await routeChildAskUser({
            request: baseRequest({
                header: 'Pick',
                source: { sessionId: 'c1', agentName: 'quick', title: 'Triage' },
            }),
            parentAnswerer: {
                tryAnswer: async () => ({ kind: 'needs_user', reason: 'preference' }),
            },
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user-choice';
            },
        });

        expect(answer).toBe('user-choice');
        expect(userCalls[0]?.header).toBe('From subagent quick: Triage — Pick');
    });

    it('escalates when the parent answerer is missing', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const answer = await routeChildAskUser({
            request: baseRequest({ source: { sessionId: 'c1', agentName: 'deep' } }),
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user-only';
            },
        });

        expect(answer).toBe('user-only');
        expect(userCalls).toHaveLength(1);
    });

    it('fail-opens to the user when the parent answerer throws', async () => {
        const userCalls: AskUserQuestionRequest[] = [];
        const answer = await routeChildAskUser({
            request: baseRequest({ source: { sessionId: 'c1', agentName: 'deep' } }),
            parentAnswerer: {
                tryAnswer: async () => {
                    throw new Error('model down');
                },
            },
            requestUserQuestion: async (request) => {
                userCalls.push(request);
                return 'user-fallback';
            },
        });

        expect(answer).toBe('user-fallback');
        expect(userCalls).toHaveLength(1);
        expect(userCalls[0]?.header).toBe('From subagent deep');
    });
});
