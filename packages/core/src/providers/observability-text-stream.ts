import { REDACTED_CREDENTIAL } from './redaction-handler.js';

export type ObservabilityTextStream = {
    readonly push: (text: string) => readonly string[];
    readonly flush: () => readonly string[];
};

type TextStreamOptions = {
    readonly redactText: (text: string) => string;
    readonly secrets: readonly string[];
    readonly maxBufferBytes: number;
};

const DEFAULT_CREDENTIAL_PREFIXES = [
    '-----BEGIN ',
    'github_pat_',
    'ghp_',
    'AKIA',
    'Bearer ',
    'eyJ',
    'AIza',
    'sk-',
] as const;

const TRAILING_CREDENTIAL_CANDIDATES = [
    /(?:^|[^A-Za-z0-9_])(github_pat_[A-Za-z0-9_]*)$/,
    /(?:^|[^A-Za-z0-9_])(ghp_[A-Za-z0-9_]*)$/,
    /(?:^|[^A-Z0-9])(AKIA[A-Z0-9]*)$/,
    /(?:^|[^A-Za-z0-9_])((?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]*)$/,
    /(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})$/,
    /(?:^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z_-]*)$/,
    /(?:^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]*)$/,
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*)$/,
] as const;

const encoder = new TextEncoder();

export function createObservabilityTextStream(options: TextStreamOptions): ObservabilityTextStream {
    const secrets = [...new Set(options.secrets.filter((secret) => secret.length > 0))];
    const maxBufferBytes = Math.max(encoder.encode(REDACTED_CREDENTIAL).byteLength, options.maxBufferBytes);
    let pending = '';
    let suppressed = false;

    return {
        push(text) {
            if (text.length === 0 || suppressed) {
                return [];
            }
            pending += text;
            const holdLength = Math.max(
                longestExactSecretPrefixSuffix(pending, secrets),
                trailingCredentialCandidateLength(pending),
                trailingCredentialPrefixLength(pending),
            );
            const safeLength = pending.length - holdLength;
            if (safeLength > 0) {
                const safe = pending.slice(0, safeLength);
                pending = pending.slice(safeLength);
                const redacted = options.redactText(safe);
                return redacted.length > 0 ? [redacted] : [];
            }
            if (encoder.encode(pending).byteLength <= maxBufferBytes) {
                return [];
            }
            pending = '';
            suppressed = true;
            const marker = options.redactText(REDACTED_CREDENTIAL);
            return marker.length > 0 ? [marker] : [];
        },
        flush() {
            if (suppressed) {
                suppressed = false;
                pending = '';
                return [];
            }
            const sensitiveSuffix =
                pending.length > 0 &&
                Math.max(
                    longestExactSecretPrefixSuffix(pending, secrets),
                    trailingCredentialCandidateLength(pending),
                ) === pending.length;
            const output = options.redactText(sensitiveSuffix ? REDACTED_CREDENTIAL : pending);
            pending = '';
            return output.length > 0 ? [output] : [];
        },
    };
}

export function composeObservabilityTextStreams(streams: readonly ObservabilityTextStream[]): ObservabilityTextStream {
    const feed = (chunks: readonly string[], startIndex: number): readonly string[] => {
        let current = chunks;
        for (let index = startIndex; index < streams.length; index += 1) {
            const stream = streams[index];
            if (stream === undefined) {
                continue;
            }
            current = current.flatMap((chunk) => stream.push(chunk));
        }
        return current;
    };
    return {
        push: (text) => feed([text], 0),
        flush: () => {
            const output: string[] = [];
            for (let index = 0; index < streams.length; index += 1) {
                const stream = streams[index];
                if (stream === undefined) {
                    continue;
                }
                output.push(...feed(stream.flush(), index + 1));
            }
            return output;
        },
    };
}

function longestExactSecretPrefixSuffix(text: string, secrets: readonly string[]): number {
    let longest = 0;
    for (const secret of secrets) {
        const limit = Math.min(text.length, secret.length - 1);
        for (let length = limit; length > longest; length -= 1) {
            if (secret.startsWith(text.slice(-length))) {
                longest = length;
                break;
            }
        }
    }
    return longest;
}

function trailingCredentialPrefixLength(text: string): number {
    let longest = 0;
    for (const prefix of DEFAULT_CREDENTIAL_PREFIXES) {
        const lowerPrefix = prefix.toLowerCase();
        const limit = Math.min(text.length, prefix.length - 1);
        for (let length = limit; length > longest; length -= 1) {
            if (lowerPrefix.startsWith(text.slice(-length).toLowerCase())) {
                longest = length;
                break;
            }
        }
    }
    return longest;
}

function trailingCredentialCandidateLength(text: string): number {
    let longest = 0;
    for (const pattern of TRAILING_CREDENTIAL_CANDIDATES) {
        const match = pattern.exec(text);
        const candidate = match?.[1];
        if (candidate !== undefined) {
            longest = Math.max(longest, candidate.length);
        }
    }
    return longest;
}
