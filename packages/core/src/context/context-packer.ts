/**
 * Context Packer (ABG §10.4, §14.2).
 *
 * Selects the message history the `LLMActor` sends to the model each turn, keeping the
 * context BOUNDED across a long (40+ step) run. When the running conversation exceeds the
 * budget, the older head is compacted into a structured summary (see compaction.ts) and the
 * recent tail is preserved verbatim. The cut-point + summary are recorded so Phase-7 replay
 * can reconstruct the packed view deterministically.
 *
 * The packer is pure (no LLM call in Phase 2 — the heuristic summarizer is deterministic),
 * which keeps compaction reproducible for replay (ABG §7.5).
 */
import type { ModelMessage } from 'ai';
import {
    type CompactionStrategy,
    type ConversationSummary,
    heuristicCompactionStrategy,
    renderSummary,
} from './compaction.js';
import { estimateMessagesTokens, estimateMessageTokens } from './token-count.js';

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 100_000;
export const DEFAULT_TAIL_RESERVE_TOKENS = 20_000;
/** Never compact below this many tail messages — the model needs recent turns verbatim. */
const MIN_TAIL_MESSAGES = 2;

export type PackContextInput = {
    readonly messages: readonly ModelMessage[];
    readonly budgetTokens?: number;
    readonly tailReserveTokens?: number;
    readonly priorSummary?: ConversationSummary;
    readonly strategy?: CompactionStrategy;
};

export type PackedContext = {
    /** The messages to send: a leading summary system message (if compacted) + the tail. */
    readonly messages: readonly ModelMessage[];
    readonly compacted: boolean;
    readonly summary: ConversationSummary | undefined;
    /** Original index before which messages were summarized (exclusive). Undefined if not compacted. */
    readonly cutPointIndex: number | undefined;
    readonly estimatedTokens: number;
};

export function packContext(input: PackContextInput): PackedContext {
    const budget = input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    const tailReserve = input.tailReserveTokens ?? DEFAULT_TAIL_RESERVE_TOKENS;
    const strategy = input.strategy ?? heuristicCompactionStrategy;
    const total = estimateMessagesTokens(input.messages);

    if (total <= budget) {
        return {
            messages: input.messages,
            compacted: false,
            summary: input.priorSummary,
            cutPointIndex: undefined,
            estimatedTokens: total,
        };
    }

    // Walk from the end to find where the verbatim tail begins (fit within tailReserve,
    // always keeping at least MIN_TAIL_MESSAGES and never splitting the very last message).
    let tailTokens = 0;
    let tailStart = input.messages.length;
    for (let index = input.messages.length - 1; index >= MIN_TAIL_MESSAGES; index -= 1) {
        const message = input.messages[index];
        if (message === undefined) {
            continue;
        }
        const cost = estimateMessageTokens(message);
        if (tailTokens + cost > tailReserve && index < input.messages.length - MIN_TAIL_MESSAGES) {
            break;
        }
        tailTokens += cost;
        tailStart = index;
    }

    const head = input.messages.slice(0, tailStart);
    const tail = input.messages.slice(tailStart);
    if (head.length === 0) {
        // Nothing left to summarize — the tail alone exceeds the budget. Trim oldest tail
        // messages to fit (best-effort); no summary. This is a degenerate oversized turn.
        return trimToBudget(tail, budget);
    }

    const summary = strategy.summarize(head, input.priorSummary);
    const summaryMessage: ModelMessage = { role: 'system', content: strategy.render(summary) };
    const packed = [summaryMessage, ...tail];
    return {
        messages: packed,
        compacted: true,
        summary,
        cutPointIndex: tailStart,
        estimatedTokens: estimateMessagesTokens(packed),
    };
}

function trimToBudget(messages: readonly ModelMessage[], budget: number): PackedContext {
    const kept: ModelMessage[] = [];
    let tokens = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined) {
            continue;
        }
        const cost = estimateMessageTokens(message);
        if (tokens + cost > budget) {
            break;
        }
        kept.unshift(message);
        tokens += cost;
    }
    return {
        messages: kept,
        compacted: true,
        summary: undefined,
        cutPointIndex: messages.length - kept.length,
        estimatedTokens: tokens,
    };
}

export { renderSummary };
