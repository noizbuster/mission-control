import type { MissionControlConfig, SessionDebugConfig } from '@mission-control/protocol';
import { SessionDebugConfigSchema } from '@mission-control/protocol';
import { stripJsoncComments } from '../../workflows/jsonc-parser';

export type SessionDebugConfigSourceMember = {
    /** Exact key/value source; comments inside the member are preserved. */
    readonly source: string;
    /** Trivia after the value and before the original separator. */
    readonly trailingTrivia: string;
    /** Trivia between the previous separator (or `{`) and the property name. */
    readonly leadingTrivia: string;
};

export type SessionDebugConfigDocument = {
    readonly config: SessionDebugConfig;
    readonly sourceMembers: readonly SessionDebugConfigSourceMember[];
    readonly error?: string;
};

const DEFAULT_SESSION_DEBUG_CONFIG = SessionDebugConfigSchema.parse({});

/**
 * Parses only the isolated `session_debug` top-level member. The normal config
 * parser intentionally receives a detached object, so malformed diagnostic
 * configuration cannot make normal command configuration unusable.
 */
export function parseSessionDebugConfigDocument(input: string): SessionDebugConfigDocument {
    const members = scanTopLevelMembers(input);
    if (members === undefined) {
        return {
            config: disabledDefaults(),
            sourceMembers: [],
            error: 'unable to inspect the session_debug configuration member',
        };
    }

    const sourceMembers = members
        .filter((member) => member.key === 'session_debug')
        .map(({ key: _key, ...member }) => member);
    if (sourceMembers.length === 0) {
        return { config: DEFAULT_SESSION_DEBUG_CONFIG, sourceMembers };
    }
    if (sourceMembers.length > 1) {
        return {
            config: disabledDefaults(),
            sourceMembers,
            error: 'duplicate top-level session_debug configuration members disable session diagnostics',
        };
    }

    const sourceMember = sourceMembers[0];
    if (sourceMember === undefined) {
        return { config: disabledDefaults(), sourceMembers, error: 'missing session_debug configuration member' };
    }
    const valueText = sourceMember.source.slice(sourceMember.source.indexOf(':') + 1);
    try {
        const parsed = JSON.parse(stripJsoncComments(valueText)) as unknown;
        const result = SessionDebugConfigSchema.safeParse(parsed);
        if (result.success) {
            return { config: result.data, sourceMembers };
        }
        return {
            config: disabledDefaults(),
            sourceMembers,
            error: 'invalid session_debug configuration disables session diagnostics',
        };
    } catch {
        return {
            config: disabledDefaults(),
            sourceMembers,
            error: 'invalid session_debug configuration disables session diagnostics',
        };
    }
}

/** Removes the diagnostic-only member before strict normal configuration parsing. */
export function detachSessionDebugConfig(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'session_debug'));
}

/**
 * Re-serializes a normal config update while keeping every existing diagnostic
 * member byte-for-byte intact. An MCP edit must not canonicalize this isolated
 * config domain, including a deliberately detectable duplicate.
 */
export function serializeConfigPreservingSessionDebug(
    config: MissionControlConfig,
    sourceMembers: readonly SessionDebugConfigSourceMember[],
): string {
    const serialized = JSON.stringify(config, null, 2);
    if (sourceMembers.length === 0) return `${serialized}\n`;

    const closeIndex = serialized.lastIndexOf('}');
    if (closeIndex < 0) throw new Error('cannot serialize session debug config into a non-object');
    const prefix = serialized.slice(0, closeIndex);
    const hasNormalMembers = Object.keys(config).length > 0;
    const sessionMembers = sourceMembers
        .map((member, index) => {
            const separator = index + 1 < sourceMembers.length ? ',' : '';
            return `${member.leadingTrivia}${member.source}${separator}${member.trailingTrivia}`;
        })
        .join('');
    return `${prefix}${hasNormalMembers ? ',' : ''}${sessionMembers}}\n`;
}

/** Explicit diagnostic edits canonicalize any duplicate members into one. */
export function serializeConfigWithSessionDebug(
    config: MissionControlConfig,
    sessionDebug: SessionDebugConfig,
): string {
    const normal = JSON.stringify(config, null, 2);
    const closeIndex = normal.lastIndexOf('}');
    if (closeIndex < 0) throw new Error('cannot serialize session debug config into a non-object');
    const prefix = normal.slice(0, closeIndex);
    const hasNormalMembers = Object.keys(config).length > 0;
    const member = JSON.stringify(sessionDebug, null, 2)
        .split('\n')
        .map((line, index) => (index === 0 ? line : `  ${line}`))
        .join('\n');
    return `${prefix}${hasNormalMembers ? ',' : ''}\n  "session_debug": ${member}\n}\n`;
}

type TopLevelMember = SessionDebugConfigSourceMember & { readonly key: string };

function disabledDefaults(): SessionDebugConfig {
    return { ...DEFAULT_SESSION_DEBUG_CONFIG, enabled: false };
}

function scanTopLevelMembers(input: string): readonly TopLevelMember[] | undefined {
    let index = skipTrivia(input, 0);
    if (input[index] !== '{') return undefined;
    index += 1;
    const members: TopLevelMember[] = [];
    let leadingStart = index;

    while (true) {
        index = skipTrivia(input, index);
        if (input[index] === '}') return members;
        const propertyStart = index;
        const property = readJsonString(input, index);
        if (property === undefined) return undefined;
        index = skipTrivia(input, property.end);
        if (input[index] !== ':') return undefined;
        index = skipTrivia(input, index + 1);
        const valueStart = index;
        const valueEnd = consumeJsonValue(input, valueStart);
        if (valueEnd === undefined) return undefined;
        index = skipTrivia(input, valueEnd);
        const trailingTrivia = input.slice(valueEnd, index);
        members.push({
            key: property.value,
            leadingTrivia: input.slice(leadingStart, propertyStart),
            source: input.slice(propertyStart, valueEnd),
            trailingTrivia,
        });
        if (input[index] === '}') return members;
        if (input[index] !== ',') return undefined;
        index += 1;
        leadingStart = index;
    }
}

function skipTrivia(input: string, start: number): number {
    let index = start;
    while (index < input.length) {
        const current = input[index];
        const next = input[index + 1];
        if (current === ' ' || current === '\t' || current === '\n' || current === '\r') {
            index += 1;
            continue;
        }
        if (current === '/' && next === '/') {
            index += 2;
            while (index < input.length && input[index] !== '\n') index += 1;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = input.indexOf('*/', index + 2);
            if (end < 0) return input.length;
            index = end + 2;
            continue;
        }
        return index;
    }
    return index;
}

function readJsonString(input: string, start: number): { readonly value: string; readonly end: number } | undefined {
    if (input[start] !== '"') return undefined;
    let index = start + 1;
    while (index < input.length) {
        const current = input[index];
        if (current === '\\') {
            index += 2;
            continue;
        }
        if (current === '"') {
            const end = index + 1;
            try {
                const value = JSON.parse(input.slice(start, end)) as unknown;
                return typeof value === 'string' ? { value, end } : undefined;
            } catch {
                return undefined;
            }
        }
        index += 1;
    }
    return undefined;
}

function consumeJsonValue(input: string, start: number): number | undefined {
    const first = input[start];
    if (first === '"') return readJsonString(input, start)?.end;
    if (first !== '{' && first !== '[') {
        let index = start;
        while (index < input.length) {
            const current = input[index];
            if (current === ',' || current === '}' || current === ']') return index;
            if (current === '/' && (input[index + 1] === '/' || input[index + 1] === '*')) return index;
            index += 1;
        }
        return undefined;
    }

    const stack: string[] = [first];
    let index = start + 1;
    while (index < input.length) {
        const current = input[index];
        const next = input[index + 1];
        if (current === '"') {
            const string = readJsonString(input, index);
            if (string === undefined) return undefined;
            index = string.end;
            continue;
        }
        if (current === '/' && next === '/') {
            index = skipTrivia(input, index);
            continue;
        }
        if (current === '/' && next === '*') {
            index = skipTrivia(input, index);
            continue;
        }
        if (current === '{' || current === '[') {
            stack.push(current);
            index += 1;
            continue;
        }
        if (current === '}' || current === ']') {
            const opening = stack.pop();
            if ((current === '}' && opening !== '{') || (current === ']' && opening !== '[')) return undefined;
            index += 1;
            if (stack.length === 0) return index;
            continue;
        }
        index += 1;
    }
    return undefined;
}

