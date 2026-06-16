/**
 * Conversation compaction (ABG §10.4, §14.2; opencode hidden-agent + pi structured-summary
 * patterns).
 *
 * When the running conversation exceeds the context budget, the older "head" is summarized
 * into a fixed structured shape and the recent "tail" is preserved verbatim. The summary is
 * ITERATIVE: when a prior summary already exists, the new summary incorporates it rather than
 * re-reading the whole head, so compaction cost stays bounded across a long (40+ step) run.
 *
 * Phase 2 uses a deterministic HEURISTIC summarizer (extracts gist from message text/tool
 * outputs — no LLM call) so the cut-point and summary are reproducible for replay (ABG §7.5).
 * A `CompactionStrategy` seam lets Phase 5/9 swap in an LLM-based summarizer without changing
 * the packer.
 */
import type { ModelMessage } from 'ai';

export type ConversationSummary = {
    readonly goal: string;
    readonly progress: readonly string[];
    readonly decisions: readonly string[];
    readonly nextSteps: readonly string[];
    readonly criticalContext: readonly string[];
    /** Number of original messages this summary represents (accumulates across iterations). */
    readonly summarizedMessageCount: number;
};

export type CompactionStrategy = {
    /** Summarize the `head` messages, incorporating `prior` if present. Deterministic. */
    summarize(head: readonly ModelMessage[], prior: ConversationSummary | undefined): ConversationSummary;
    /** Render a summary to a system-message body. */
    render(summary: ConversationSummary): string;
};

const MAX_PROGRESS_ITEMS = 12;
const MAX_DECISION_ITEMS = 8;
const MAX_CONTEXT_ITEMS = 8;
const MAX_NEXT_STEPS = 6;
const SNIPPET_CHARS = 320;

/** The Phase-2 deterministic heuristic summarizer. */
export const heuristicCompactionStrategy: CompactionStrategy = {
    summarize: summarizeHead,
    render: renderSummary,
};

export function summarizeHead(
    head: readonly ModelMessage[],
    prior: ConversationSummary | undefined,
): ConversationSummary {
    const goal = prior?.goal ?? firstUserText(head) ?? 'Continue the mission.';
    const progress: string[] = prior ? [...prior.progress] : [];
    const decisions: string[] = prior ? [...prior.decisions] : [];
    const criticalContext: string[] = prior ? [...prior.criticalContext] : [];
    let lastAssistantText: string | undefined;

    for (const message of head) {
        if (message.role === 'user') {
            const text = messageText(message);
            if (text !== undefined && !progress.includes(text)) {
                pushCapped(progress, text, MAX_PROGRESS_ITEMS);
            }
        } else if (message.role === 'assistant') {
            const text = messageText(message);
            if (text !== undefined) {
                lastAssistantText = text;
                if (!decisions.includes(text)) {
                    pushCapped(decisions, text, MAX_DECISION_ITEMS);
                }
                pushCapped(progress, text, MAX_PROGRESS_ITEMS);
            }
        } else if (message.role === 'tool') {
            const gist = truncate(toolResultGist(message), SNIPPET_CHARS);
            if (gist.length > 0 && !criticalContext.includes(gist)) {
                pushCapped(criticalContext, gist, MAX_CONTEXT_ITEMS);
            }
        }
    }

    const nextSteps: string[] = [];
    if (lastAssistantText !== undefined) {
        nextSteps.push(truncate(lastAssistantText, SNIPPET_CHARS));
    }
    if (prior) {
        for (const step of prior.nextSteps) {
            if (!nextSteps.includes(step)) {
                pushCapped(nextSteps, step, MAX_NEXT_STEPS);
            }
        }
    }

    return {
        goal,
        progress,
        decisions,
        nextSteps,
        criticalContext,
        summarizedMessageCount: (prior?.summarizedMessageCount ?? 0) + head.length,
    };
}

export function renderSummary(summary: ConversationSummary): string {
    const lines: string[] = ['[Prior conversation summary — compacted context, treat as reference]'];
    lines.push(`Goal: ${summary.goal}`);
    if (summary.progress.length > 0) {
        lines.push(`Progress:\n${bullet(summary.progress)}`);
    }
    if (summary.decisions.length > 0) {
        lines.push(`Decisions:\n${bullet(summary.decisions)}`);
    }
    if (summary.nextSteps.length > 0) {
        lines.push(`Next steps:\n${bullet(summary.nextSteps)}`);
    }
    if (summary.criticalContext.length > 0) {
        lines.push(`Critical context:\n${bullet(summary.criticalContext)}`);
    }
    return lines.join('\n');
}

function bullet(items: readonly string[]): string {
    return items.map((item) => `- ${item}`).join('\n');
}

function pushCapped(list: string[], item: string, cap: number): void {
    if (list.length >= cap) {
        return;
    }
    list.push(truncate(item, SNIPPET_CHARS));
}

function truncate(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function firstUserText(messages: readonly ModelMessage[]): string | undefined {
    for (const message of messages) {
        if (message.role === 'user') {
            const text = messageText(message);
            if (text !== undefined) {
                return truncate(text, SNIPPET_CHARS);
            }
        }
    }
    return undefined;
}

function messageText(message: ModelMessage): string | undefined {
    const content = message.content;
    if (typeof content === 'string') {
        return content.trim().length > 0 ? content.trim() : undefined;
    }
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n')
        .trim();
    return text.length > 0 ? text : undefined;
}

function toolResultGist(message: ModelMessage): string {
    const content = message.content;
    if (typeof content === 'string') {
        return content;
    }
    return content
        .filter((part) => part.type === 'tool-result')
        .map((part) => (part.type === 'tool-result' ? stringify(part.output) : ''))
        .join('\n');
}

function stringify(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
