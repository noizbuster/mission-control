/**
 * Pure helpers for graph-run agent status lines shown above the prompt.
 */

export type RetryableFailureInfo = {
    readonly retryable: boolean;
    readonly shortReason: string;
};

export function describeRetryableFailure(error: unknown): RetryableFailureInfo {
    const message = readErrorMessage(error);
    const code = readErrorCode(error);
    const retryable = isRetryableFailure(error, code, message);
    return {
        retryable,
        shortReason: shortReasonForFailure(code, message),
    };
}

export function formatNodeRetryStatus(input: {
    readonly nodeId: string;
    readonly shortReason: string;
    readonly attempt?: number;
    readonly maxAttempts?: number;
}): string {
    const label = formatNodeLabel(input.nodeId);
    const progress =
        input.attempt !== undefined && input.maxAttempts !== undefined
            ? ` (${input.attempt}/${input.maxAttempts})`
            : '';
    return `${label} hit ${input.shortReason} — retrying${progress}…`;
}

export function formatNodeWorkingStatus(nodeId: string, attempt?: number): string {
    const label = formatNodeLabel(nodeId);
    if (attempt !== undefined && attempt > 1) {
        return `${label} (attempt ${attempt})…`;
    }
    return `${label}…`;
}

export function formatThinkingStatus(nodeId?: string): string {
    if (nodeId === undefined || nodeId.length === 0) return 'Thinking…';
    const label = formatNodeLabel(nodeId);
    if (label === nodeId.replace(/-/g, ' ')) return 'Thinking…';
    return `Thinking… (${label})`;
}

const NODE_LABELS: Readonly<Record<string, string>> = {
    'intent-gate': 'Classifying intent',
    'direct-respond': 'Responding',
    'research-explore': 'Exploring',
    'route-planner': 'Planning',
    'maturity-sample': 'Sampling codebase maturity',
    'maturity-classify': 'Classifying codebase maturity',
    'anti-dup-guard': 'Checking for duplicates',
    'todo-plan': 'Planning tasks',
    'delegate-wave': 'Delegating',
    'delegate-worker': 'Working on task',
    'verify-wave': 'Verifying',
    'evidence-check': 'Checking evidence',
    supervisor: 'Reviewing progress',
    'final-respond': 'Composing answer',
    clarify: 'Asking for clarification',
};

export function formatNodeLabel(nodeId: string): string {
    return NODE_LABELS[nodeId] ?? nodeId.replace(/-/g, ' ');
}

function isRetryableFailure(error: unknown, code: string | undefined, message: string): boolean {
    if (isPlainObject(error) && error['retryable'] === true) return true;
    if (isPlainObject(error) && error['retryable'] === false) {
        // Rate-limit / overload still retry at graph maxAttempts even when a layer marks
        // retryable:false or retryExhausted after its own budget.
        return code === 'provider_rate_limited' || code === 'provider_timeout' || isOverloadText(message);
    }
    return code === 'provider_rate_limited' || code === 'provider_timeout' || isOverloadText(message);
}

function shortReasonForFailure(code: string | undefined, message: string): string {
    if (code === 'provider_rate_limited' || isOverloadText(message)) return 'temporary overload';
    if (code === 'provider_timeout') return 'timeout';
    if (message.length > 0) {
        const firstLine = message.split('\n')[0] ?? message;
        return firstLine.length > 48 ? `${firstLine.slice(0, 45)}…` : firstLine;
    }
    return 'a temporary error';
}

function isOverloadText(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes('overloaded')
        || lower.includes('rate limit')
        || lower.includes('try again later')
        || lower.includes('too many requests')
    );
}

function readErrorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (isPlainObject(error) && typeof error['message'] === 'string') return error['message'];
    return '';
}

function readErrorCode(error: unknown): string | undefined {
    if (isPlainObject(error) && typeof error['code'] === 'string') return error['code'];
    return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
