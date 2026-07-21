import type { AbgNodeModelOptions } from '@mission-control/protocol';
import { generateText } from 'ai';
import type { LlmActorModel } from '../behavior/nodes/llm-actor/llm-actor-node';
import type { AskUserQuestionRequest } from './ask-user-schemas';
import type { ChildAskUserParentAnswerer, ChildAskUserParentDecision } from './child-ask-user-router';

const PARENT_ASK_USER_SYSTEM_PROMPT =
    'You are the parent Mission Control agent. A subagent asked the user a question. ' +
    'If you can confidently answer from the assignment context without needing the human\'s ' +
    'personal preference, secrets, or approval, reply with exactly one line:\n' +
    'ANSWER <text>\n' +
    'Otherwise reply exactly:\n' +
    'NEEDS_USER <short reason>';

export type ChildAskUserParentAnswererOptions = {
    readonly resolveSdkModel: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly model: AbgNodeModelOptions;
    readonly generate?: typeof generateText;
    /** Optional short parent context summary for the one-shot turn. */
    readonly parentContext?: string;
};

/**
 * One-shot parent LLM answerer for child ask_user. Fail-open to needs_user on
 * model/transport/parse errors so the child never hangs waiting on the parent.
 */
export function createChildAskUserParentAnswerer(
    options: ChildAskUserParentAnswererOptions,
): ChildAskUserParentAnswerer {
    const generate = options.generate ?? generateText;
    return {
        tryAnswer: async (request: AskUserQuestionRequest): Promise<ChildAskUserParentDecision> => {
            try {
                const result = await generate({
                    model: options.resolveSdkModel(options.model),
                    system: PARENT_ASK_USER_SYSTEM_PROMPT,
                    prompt: formatParentAskUserPrompt(request, options.parentContext),
                    maxOutputTokens: 256,
                });
                return parseParentAskUserDecisionText(result.text);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return { kind: 'needs_user', reason: `parent ask_user answerer failed: ${message}` };
            }
        },
    };
}

export function formatParentAskUserPrompt(
    request: AskUserQuestionRequest,
    parentContext: string | undefined,
): string {
    const lines: string[] = [];
    if (parentContext !== undefined && parentContext.length > 0) {
        lines.push(`parentContext: ${parentContext}`);
    }
    const source = request.source;
    if (source !== undefined) {
        lines.push(`childSessionId: ${source.sessionId}`);
        if (source.agentName !== undefined) {
            lines.push(`childAgent: ${source.agentName}`);
        }
        if (source.category !== undefined) {
            lines.push(`childCategory: ${source.category}`);
        }
        if (source.title !== undefined) {
            lines.push(`childTitle: ${source.title}`);
        }
    }
    if (request.header !== undefined) {
        lines.push(`header: ${request.header}`);
    }
    lines.push(`question: ${request.question}`);
    if (request.options.length > 0) {
        const labels = request.options.map((option) => (typeof option === 'string' ? option : option.label));
        lines.push(`options: ${labels.join(' | ')}`);
    }
    if (request.multiple === true) {
        lines.push('multiple: true');
    }
    lines.push('Decide ANSWER <text> or NEEDS_USER <reason>.');
    return lines.join('\n');
}

/**
 * Parse a parent answerer one-shot response into a typed decision.
 * Fail-open to needs_user on empty or unrecognized text.
 */
export function parseParentAskUserDecisionText(text: string): ChildAskUserParentDecision {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return { kind: 'needs_user', reason: 'empty parent response' };
    }
    const lines = trimmed.split(/\r?\n/);
    const firstLine = lines.map((line) => line.trim()).find((line) => line.length > 0);
    if (firstLine === undefined) {
        return { kind: 'needs_user', reason: 'empty parent response' };
    }

    if (/^ANSWER\b/i.test(firstLine)) {
        const restOfFirst = firstLine.replace(/^ANSWER\s*/i, '').trim();
        if (restOfFirst.length > 0) {
            return { kind: 'answer', answer: restOfFirst };
        }
        const body = lines
            .slice(1)
            .join('\n')
            .trim();
        if (body.length > 0) {
            return { kind: 'answer', answer: body };
        }
        return { kind: 'needs_user', reason: 'empty ANSWER body' };
    }

    if (/^NEEDS_USER\b/i.test(firstLine)) {
        const reason = firstLine.replace(/^NEEDS_USER\s*/i, '').trim();
        return reason.length > 0 ? { kind: 'needs_user', reason } : { kind: 'needs_user' };
    }

    return {
        kind: 'needs_user',
        reason: `unrecognized parent response: ${firstLine.slice(0, 120)}`,
    };
}
