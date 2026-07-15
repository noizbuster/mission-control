export const OBSERVABILITY_UNAVAILABLE = '[UNAVAILABLE]';

type RedactValueOptions = {
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly circularMarker: string;
    readonly truncatedMarker: string;
    readonly redactText: (text: string) => string;
    readonly redactIdentifier: (identifier: string) => string;
};

type TraversalState = {
    remainingEntries: number;
    readonly ancestors: WeakSet<object>;
};

type BuiltValue = {
    readonly value: unknown;
    readonly bytes: number;
};

type ObjectEntry = readonly [string, unknown];

const IDENTIFIER_KEYS = new Set([
    'approvalId',
    'causationId',
    'correlationId',
    'eventId',
    'messageId',
    'providerCallId',
    'providerItemId',
    'requestId',
    'sessionId',
    'taskId',
    'toolCallId',
    'turnId',
]);
const encoder = new TextEncoder();

export function redactObservabilityValue(value: unknown, options: RedactValueOptions): unknown {
    const state: TraversalState = { remainingEntries: options.maxEntries, ancestors: new WeakSet() };
    return buildValue(value, options.maxBytes, 0, state, options).value;
}

function buildValue(
    value: unknown,
    availableBytes: number,
    depth: number,
    state: TraversalState,
    options: RedactValueOptions,
    key?: string,
): BuiltValue {
    if (depth > options.maxDepth || state.remainingEntries <= 0) {
        return buildString(options.truncatedMarker, availableBytes, options.truncatedMarker);
    }
    if (typeof value === 'string') {
        const redacted =
            key !== undefined && IDENTIFIER_KEYS.has(key) ? options.redactIdentifier(value) : options.redactText(value);
        return buildString(redacted, availableBytes, options.truncatedMarker);
    }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
        return buildPrimitive(value, availableBytes, options.truncatedMarker, key === undefined);
    }
    if (typeof value !== 'object') {
        return buildString(OBSERVABILITY_UNAVAILABLE, availableBytes, options.truncatedMarker);
    }
    if (state.ancestors.has(value)) {
        return buildString(options.circularMarker, availableBytes, options.truncatedMarker);
    }
    state.ancestors.add(value);
    try {
        try {
            if (Array.isArray(value)) {
                return buildArray(value, availableBytes, depth, state, options);
            }
        } catch {
            return buildString(OBSERVABILITY_UNAVAILABLE, availableBytes, options.truncatedMarker);
        }
        return buildObject(value, availableBytes, depth, state, options);
    } finally {
        state.ancestors.delete(value);
    }
}

function buildArray(
    values: readonly unknown[],
    availableBytes: number,
    depth: number,
    state: TraversalState,
    options: RedactValueOptions,
): BuiltValue {
    if (availableBytes < 2) {
        return buildString('', availableBytes, options.truncatedMarker);
    }
    const output: unknown[] = [];
    let bytes = 2;
    for (const entry of values) {
        const separatorBytes = output.length === 0 ? 0 : 1;
        const childAvailable = availableBytes - bytes - separatorBytes;
        if (childAvailable < 2 || state.remainingEntries <= 0) {
            appendArrayTruncation(output, availableBytes, bytes, options.truncatedMarker);
            break;
        }
        state.remainingEntries -= 1;
        const child = buildValue(entry, childAvailable, depth + 1, state, options);
        output.push(child.value);
        bytes += separatorBytes + child.bytes;
    }
    return { value: output, bytes: serializedBytes(output) };
}

function buildObject(
    value: object,
    availableBytes: number,
    depth: number,
    state: TraversalState,
    options: RedactValueOptions,
): BuiltValue {
    if (availableBytes < 2) {
        return buildString('', availableBytes, options.truncatedMarker);
    }
    const entries = observableEntries(value, options.truncatedMarker);
    if (entries === undefined) {
        return buildString(OBSERVABILITY_UNAVAILABLE, availableBytes, options.truncatedMarker);
    }
    const output: ObjectEntry[] = [];
    const usedKeys = new Set<string>();
    let bytes = 2;
    for (const [rawKey, entry] of entries) {
        if (state.remainingEntries <= 0) {
            appendObjectTruncation(output, usedKeys, availableBytes, bytes, options.truncatedMarker);
            break;
        }
        const key = uniqueKey(options.redactText(rawKey), usedKeys);
        const keyBytes = serializedBytes(key);
        const separatorBytes = output.length === 0 ? 0 : 1;
        const overhead = separatorBytes + keyBytes + 1;
        const childAvailable = availableBytes - bytes - overhead;
        if (childAvailable < 2) {
            appendObjectTruncation(output, usedKeys, availableBytes, bytes, options.truncatedMarker);
            break;
        }
        state.remainingEntries -= 1;
        const child = buildValue(entry, childAvailable, depth + 1, state, options, rawKey);
        output.push([key, child.value]);
        usedKeys.add(key);
        bytes += overhead + child.bytes;
    }
    const object = Object.fromEntries(output);
    return { value: object, bytes: serializedBytes(object) };
}

function observableEntries(value: object, marker: string): readonly ObjectEntry[] | undefined {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const entries: ObjectEntry[] = [];
        const errorLike = value instanceof Error;
        if (errorLike && descriptors['name'] === undefined) {
            entries.push(['name', 'Error']);
        }
        for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || (!descriptor.enumerable && !errorLike)) {
                continue;
            }
            entries.push([key, 'value' in descriptor ? descriptor.value : marker]);
        }
        if (entries.length > 0 || errorLike) {
            return entries;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null ? [] : [['value', OBSERVABILITY_UNAVAILABLE]];
    } catch {
        return undefined;
    }
}

function buildPrimitive(
    value: null | number | boolean | undefined,
    availableBytes: number,
    marker: string,
    arrayEntry: boolean,
): BuiltValue {
    if (value === undefined) {
        return { value, bytes: arrayEntry ? serializedBytes(null) : 0 };
    }
    const normalized = typeof value === 'number' && !Number.isFinite(value) ? null : value;
    const bytes = serializedBytes(normalized);
    return bytes <= availableBytes ? { value: normalized, bytes } : buildString(marker, availableBytes, marker);
}

function buildString(value: string, availableBytes: number, marker: string): BuiltValue {
    const bytes = serializedBytes(value);
    if (bytes <= availableBytes) {
        return { value, bytes };
    }
    const markerBytes = serializedBytes(marker);
    if (markerBytes > availableBytes) {
        return { value: '', bytes: 2 };
    }
    const characters: string[] = [];
    let usedBytes = markerBytes;
    for (const character of value) {
        const characterBytes = serializedBytes(character) - 2;
        if (usedBytes + characterBytes > availableBytes) {
            break;
        }
        characters.push(character);
        usedBytes += characterBytes;
    }
    const truncated = `${characters.join('')}${marker}`;
    return { value: truncated, bytes: serializedBytes(truncated) };
}

function appendArrayTruncation(output: unknown[], availableBytes: number, currentBytes: number, marker: string): void {
    const separator = output.length === 0 ? 0 : 1;
    if (currentBytes + separator + serializedBytes(marker) <= availableBytes) {
        output.push(marker);
    }
}

function appendObjectTruncation(
    output: ObjectEntry[],
    usedKeys: Set<string>,
    availableBytes: number,
    currentBytes: number,
    marker: string,
): void {
    const key = uniqueKey('__truncated__', usedKeys);
    const separator = output.length === 0 ? 0 : 1;
    const addedBytes = separator + serializedBytes(key) + 1 + serializedBytes(marker);
    if (currentBytes + addedBytes <= availableBytes) {
        output.push([key, marker]);
        usedKeys.add(key);
    }
}

function uniqueKey(base: string, used: ReadonlySet<string>): string {
    if (!used.has(base)) {
        return base;
    }
    let suffix = 2;
    while (used.has(`${base}#${suffix}`)) {
        suffix += 1;
    }
    return `${base}#${suffix}`;
}

function serializedBytes(value: unknown): number {
    return encoder.encode(JSON.stringify(value) ?? 'null').byteLength;
}
