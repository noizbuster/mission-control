import type { AskUserQuestionRequest, AskUserQuestionSource } from './ask-user-schemas';

export type ChildAskUserParentDecision =
    | { readonly kind: 'answer'; readonly answer: string }
    | { readonly kind: 'needs_user'; readonly reason?: string };

export type ChildAskUserParentAnswerer = {
    readonly tryAnswer: (request: AskUserQuestionRequest) => Promise<ChildAskUserParentDecision>;
};

export type RouteChildAskUserOptions = {
    readonly request: AskUserQuestionRequest;
    readonly parentAnswerer?: ChildAskUserParentAnswerer;
    readonly requestUserQuestion: (request: AskUserQuestionRequest) => Promise<string>;
};

export type ChildAskUserSourceFields = {
    readonly agentName?: string;
    readonly category?: string;
    readonly title?: string;
};

/**
 * Stamp child-session source metadata onto an ask_user request without mutating
 * the input. Uses exactOptionalPropertyTypes-safe spreads.
 */
export function withChildAskUserSource(
    request: AskUserQuestionRequest,
    source: AskUserQuestionSource,
): AskUserQuestionRequest {
    return {
        ...request,
        source,
    };
}

/**
 * Build the overlay header label for a child-originated ask_user request.
 * Examples: `From subagent deep`, `From subagent deep: Investigate auth`.
 * Merges with an existing header when present.
 */
export function formatChildAskUserHeader(request: AskUserQuestionRequest): string | undefined {
    const sourceLabel = formatSourceLabel(request.source);
    const existing = request.header;
    if (sourceLabel === undefined) {
        return existing;
    }
    if (existing === undefined || existing.length === 0) {
        return sourceLabel;
    }
    if (existing === sourceLabel || existing.startsWith(`${sourceLabel} — `) || existing.startsWith('From subagent ')) {
        return existing;
    }
    return `${sourceLabel} — ${existing}`;
}

function formatSourceLabel(source: AskUserQuestionSource | undefined): string | undefined {
    if (source === undefined) {
        return undefined;
    }
    const name = source.agentName ?? source.category;
    const title = source.title;
    if (name !== undefined && name.length > 0) {
        return title !== undefined && title.length > 0 ? `From subagent ${name}: ${title}` : `From subagent ${name}`;
    }
    if (title !== undefined && title.length > 0) {
        return `From subagent: ${title}`;
    }
    return 'From subagent';
}

function enrichRequestForUser(request: AskUserQuestionRequest): AskUserQuestionRequest {
    const header = formatChildAskUserHeader(request);
    if (header === undefined) {
        return request;
    }
    if (request.header === header) {
        return request;
    }
    return {
        ...request,
        header,
    };
}

/**
 * Parent-first routing for child ask_user:
 * 1. requiresUserConfirmation → user overlay (source header enriched)
 * 2. parentAnswerer.tryAnswer → answer short-circuits; needs_user escalates
 * 3. missing answerer / throw → escalate fail-open to user
 */
export async function routeChildAskUser(options: RouteChildAskUserOptions): Promise<string> {
    const escalate = (): Promise<string> => options.requestUserQuestion(enrichRequestForUser(options.request));

    if (options.request.requiresUserConfirmation === true) {
        return escalate();
    }

    const answerer = options.parentAnswerer;
    if (answerer === undefined) {
        return escalate();
    }

    try {
        const decision = await answerer.tryAnswer(options.request);
        switch (decision.kind) {
            case 'answer':
                return decision.answer;
            case 'needs_user':
                return escalate();
            default: {
                const _exhaustive: never = decision;
                return _exhaustive;
            }
        }
    } catch {
        // no-excuse-ok: catch — parent answerer must fail-open to the user overlay
        return escalate();
    }
}
