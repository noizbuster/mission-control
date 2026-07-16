/** Error-chain walk and provider/transport heuristics for failure taxonomy. */

export type InspectedFailureSignals = {
    readonly explicitCode: string | undefined;
    readonly explicitRetryable: boolean | undefined;
    readonly statusCode: number | undefined;
    readonly isRetryableFlag: boolean | undefined;
    readonly message: string;
    readonly joinedCodes: string;
};

export function inspectFailureSignals(input: unknown): InspectedFailureSignals {
    const chain = errorChain(input);
    let explicitCode: string | undefined;
    let explicitRetryable: boolean | undefined;
    let statusCode: number | undefined;
    let isRetryableFlag: boolean | undefined;
    const messages: string[] = [];
    const codes: string[] = [];

    for (const item of chain) {
        const itemCode = codeOfString(item);
        explicitCode ??= itemCode;
        if (itemCode !== undefined) codes.push(itemCode);
        explicitRetryable ??= retryableOf(item);
        statusCode ??= statusCodeOf(item);
        isRetryableFlag ??= isRetryableOf(item);
        const message = messageOf(item);
        if (message !== undefined && message.length > 0) messages.push(message);
        const name = nameOf(item);
        if (name !== undefined && name.length > 0) messages.push(name);
    }

    return {
        explicitCode,
        explicitRetryable,
        statusCode,
        isRetryableFlag,
        message: messages.join('\n'),
        joinedCodes: codes.join('\n'),
    };
}

export function hasClassifiableSignal(error: unknown): boolean {
    if (error === undefined || error === null) return false;
    for (const item of errorChain(error)) {
        if (codeOfString(item) !== undefined) return true;
        if (statusCodeOf(item) !== undefined) return true;
        if (isRetryableOf(item) !== undefined) return true;
        if (retryableOf(item) !== undefined) return true;
        const message = messageOf(item);
        if (message !== undefined && message.length > 0) return true;
        if (nameOf(item) !== undefined) return true;
    }
    return false;
}

export function isTransientProviderFailure(input: {
    readonly statusCode: number | undefined;
    readonly message: string;
    readonly code: string | undefined;
}): boolean {
    if (
        input.statusCode === 429 ||
        input.statusCode === 502 ||
        input.statusCode === 503 ||
        input.statusCode === 504 ||
        input.statusCode === 529
    ) {
        return true;
    }
    if (input.statusCode !== undefined && input.statusCode >= 500 && input.statusCode < 600) {
        return true;
    }
    const code = (input.code ?? '').toLowerCase();
    if (
        code === 'rate_limit_exceeded' ||
        code === 'overloaded_error' ||
        code === 'overloaded' ||
        code === 'server_error' ||
        code === 'provider_rate_limited'
    ) {
        return true;
    }
    const message = input.message.toLowerCase();
    return (
        message.includes('temporarily overloaded') ||
        message.includes('service may be temporarily overloaded') ||
        message.includes('overloaded') ||
        message.includes('rate limit') ||
        message.includes('too many requests') ||
        message.includes('try again later')
    );
}

export function isNetworkProviderFailure(input: {
    readonly message: string;
    readonly code: string | undefined;
}): boolean {
    const code = (input.code ?? '').toLowerCase();
    if (
        code === 'econnreset' ||
        code === 'econnrefused' ||
        code === 'enotfound' ||
        code === 'etimedout' ||
        code === 'eai_again' ||
        code === 'enetunreach' ||
        code === 'ehostunreach' ||
        code === 'econnaborted' ||
        code === 'epipe' ||
        code === 'err_network' ||
        code === 'err_network_changed' ||
        code.startsWith('und_err_')
    ) {
        return true;
    }
    for (const segment of code.split(/[\n,\s]+/)) {
        if (
            segment === 'econnreset' ||
            segment === 'econnrefused' ||
            segment === 'enotfound' ||
            segment === 'etimedout' ||
            segment === 'eai_again' ||
            segment === 'err_network' ||
            segment.startsWith('und_err_')
        ) {
            return true;
        }
    }
    const message = input.message.toLowerCase();
    return (
        message.includes('fetch failed') ||
        message.includes('network request failed') ||
        message.includes('networkerror') ||
        message.includes('socket hang up') ||
        message.includes('other side closed') ||
        message.includes('connection reset') ||
        message.includes('connection refused') ||
        message.includes('connect timeout') ||
        message.includes('headers timeout') ||
        message.includes('body timeout') ||
        message.includes('getaddrinfo') ||
        message.includes('failed to fetch')
    );
}

function errorChain(error: unknown): readonly unknown[] {
    const chain: unknown[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        if (typeof current !== 'object') break;
        if (hasField(current, 'lastError')) {
            current = current.lastError;
            continue;
        }
        if (hasField(current, 'cause')) {
            current = current.cause;
            continue;
        }
        if (hasField(current, 'error')) {
            current = current.error;
            continue;
        }
        break;
    }
    return chain;
}

function retryableOf(value: unknown): boolean | undefined {
    if (hasField(value, 'retryable')) return typeof value.retryable === 'boolean' ? value.retryable : undefined;
    return undefined;
}

function isRetryableOf(value: unknown): boolean | undefined {
    if (hasField(value, 'isRetryable')) return typeof value.isRetryable === 'boolean' ? value.isRetryable : undefined;
    return undefined;
}

function statusCodeOf(value: unknown): number | undefined {
    if (hasField(value, 'statusCode') && typeof value.statusCode === 'number') return value.statusCode;
    if (hasField(value, 'status') && typeof value.status === 'number') return value.status;
    return undefined;
}

function messageOf(value: unknown): string | undefined {
    if (hasField(value, 'message') && typeof value.message === 'string') return value.message;
    if (value instanceof Error) return value.message;
    return undefined;
}

function nameOf(value: unknown): string | undefined {
    if (value instanceof Error && value.name.length > 0) return value.name;
    if (hasField(value, 'name') && typeof value.name === 'string' && value.name.length > 0) return value.name;
    return undefined;
}

function codeOfString(value: unknown): string | undefined {
    if (hasField(value, 'code') && typeof value.code === 'string') return value.code;
    return undefined;
}

function hasField<Field extends string>(value: unknown, field: Field): value is Record<Field, unknown> {
    return typeof value === 'object' && value !== null && field in value;
}
