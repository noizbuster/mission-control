import { describe, expect, it, vi } from 'vitest';
import type { AskUserQuestionRequest } from './ask-user-schemas';
import {
    type ChildAskUserParentAnswererOptions,
    createChildAskUserParentAnswerer,
    formatParentAskUserPrompt,
    parseParentAskUserDecisionText,
} from './child-ask-user-parent-answerer';

// generate is injected in these tests; model is only required for typing of the generate call.
const stubModelResolver = (() => ({})) as unknown as ChildAskUserParentAnswererOptions['resolveSdkModel'];

const sampleRequest: AskUserQuestionRequest = {
    question: 'Use dark theme?',
    options: ['yes', 'no'],
    source: {
        sessionId: 'child-ask',
        agentName: 'deep',
        title: 'UI polish',
    },
};

describe('parseParentAskUserDecisionText', () => {
    it('parses ANSWER with inline text', () => {
        expect(parseParentAskUserDecisionText('ANSWER yes, dark theme')).toEqual({
            kind: 'answer',
            answer: 'yes, dark theme',
        });
    });

    it('parses multi-line ANSWER body', () => {
        expect(parseParentAskUserDecisionText('ANSWER\nuse the existing default')).toEqual({
            kind: 'answer',
            answer: 'use the existing default',
        });
    });

    it('parses NEEDS_USER with a reason', () => {
        expect(parseParentAskUserDecisionText('NEEDS_USER personal preference')).toEqual({
            kind: 'needs_user',
            reason: 'personal preference',
        });
    });

    it('parses bare NEEDS_USER', () => {
        expect(parseParentAskUserDecisionText('NEEDS_USER')).toEqual({ kind: 'needs_user' });
    });

    it('fail-opens on empty text', () => {
        expect(parseParentAskUserDecisionText('   ')).toEqual({
            kind: 'needs_user',
            reason: 'empty parent response',
        });
    });

    it('fail-opens on unrecognized text', () => {
        const decision = parseParentAskUserDecisionText('maybe later');
        expect(decision.kind).toBe('needs_user');
        if (decision.kind === 'needs_user') {
            expect(decision.reason).toContain('unrecognized parent response');
        }
    });

    it('fail-opens on empty ANSWER body', () => {
        expect(parseParentAskUserDecisionText('ANSWER')).toEqual({
            kind: 'needs_user',
            reason: 'empty ANSWER body',
        });
    });
});

describe('formatParentAskUserPrompt', () => {
    it('includes question, options, and child source fields', () => {
        const prompt = formatParentAskUserPrompt(sampleRequest, 'parent is implementing auth');
        expect(prompt).toContain('parentContext: parent is implementing auth');
        expect(prompt).toContain('childSessionId: child-ask');
        expect(prompt).toContain('childAgent: deep');
        expect(prompt).toContain('childTitle: UI polish');
        expect(prompt).toContain('question: Use dark theme?');
        expect(prompt).toContain('options: yes | no');
    });
});

describe('createChildAskUserParentAnswerer', () => {
    it('maps ANSWER text from the parent agent into an answer decision', async () => {
        const generate = vi.fn(async () => ({ text: 'ANSWER proceed with defaults' }));
        const answerer = createChildAskUserParentAnswerer({
            resolveSdkModel: stubModelResolver,
            model: { providerID: 'local', modelID: 'local-echo' },
            generate: generate as never,
        });

        const decision = await answerer.tryAnswer(sampleRequest);

        expect(decision).toEqual({ kind: 'answer', answer: 'proceed with defaults' });
        expect(generate).toHaveBeenCalledOnce();
    });

    it('fail-opens to needs_user when generate throws', async () => {
        const answerer = createChildAskUserParentAnswerer({
            resolveSdkModel: stubModelResolver,
            model: { providerID: 'local', modelID: 'local-echo' },
            generate: (async () => {
                throw new Error('provider down');
            }) as never,
        });

        const decision = await answerer.tryAnswer(sampleRequest);

        expect(decision.kind).toBe('needs_user');
        if (decision.kind === 'needs_user') {
            expect(decision.reason).toContain('provider down');
        }
    });
});
