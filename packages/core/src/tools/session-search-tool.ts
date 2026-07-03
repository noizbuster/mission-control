/**
 * `session_search` tool — full-text search across durable session messages.
 *
 * Read layer over the EXISTING `<dataDir>/sessions/<id>.jsonl` store (see
 * `session-tools-shared.ts`). Capability class `['read']`, no approval. Bounded: a 60s overall
 * timeout and a 50-session scan cap when no `session_id` is given. Matched excerpts are
 * defensively redacted.
 */

import { z } from 'zod';
import {
    DEFAULT_SEARCH_LIMIT,
    extractMessages,
    listSessionIds,
    MAX_SESSIONS_TO_SCAN,
    readSessionProjection,
    redactSessionText,
    SESSION_SEARCH_TIMEOUT_MS,
    type SessionToolsOptions,
} from './session-tools-shared.js';
import type { ToolRegistration } from './tool-registry-types.js';

const OUTPUT_LIMIT_CHARS = 8000;
const EXCERPT_RADIUS = 60;

export const sessionSearchInputSchema = z.object({
    query: z.string().min(1).describe('Search query string.'),
    session_id: z.string().min(1).optional().describe('Search within a specific session only.'),
    case_sensitive: z.boolean().optional().describe('Case-sensitive search (default false).'),
    limit: z.number().int().positive().max(100).optional().describe('Maximum results to return.'),
});

export type SessionSearchInput = z.infer<typeof sessionSearchInputSchema>;

export type SessionSearchResult = {
    readonly sessionId: string;
    readonly messageId: string;
    readonly role: string;
    readonly excerpt: string;
    readonly matchCount: number;
    readonly timestamp: string;
};

export type SessionSearchOutput = {
    readonly results: readonly SessionSearchResult[];
    readonly timedOut: boolean;
    readonly sessionsScanned: number;
    readonly truncated: boolean;
};

export const sessionSearchParametersJsonSchema = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'Search query string.' },
        session_id: { type: 'string', description: 'Search within a specific session only.' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default false).' },
        limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_SEARCH_LIMIT}).` },
    },
    required: ['query'],
    additionalProperties: false,
} as const;

export function formatSessionSearchModelOutput(output: SessionSearchOutput): string {
    if (output.timedOut) {
        return `Search timed out after ${SESSION_SEARCH_TIMEOUT_MS}ms (scanned ${output.sessionsScanned} sessions, ${output.results.length} matches so far). Narrow the query or pass session_id.`;
    }
    if (output.results.length === 0) {
        return `No matches found (scanned ${output.sessionsScanned} session${output.sessionsScanned === 1 ? '' : 's'}).`;
    }
    const lines: string[] = [`Found ${output.results.length} matches:\n`];
    for (const result of output.results) {
        lines.push(`[${result.sessionId}] ${result.messageId} (${result.role}) ${result.timestamp}`);
        lines.push(`  ${result.excerpt}`);
        lines.push(`  matches: ${result.matchCount}\n`);
    }
    if (output.truncated) {
        lines.push('[truncated; pass a lower limit or a more specific query for more]');
    }
    return lines.join('\n');
}

export function createSessionSearchToolRegistration(
    options?: SessionToolsOptions,
): ToolRegistration<SessionSearchInput, SessionSearchOutput> {
    return {
        name: 'session_search',
        description:
            'Search for content within durable mission-control session messages. Returns matching excerpts. Bounded: 60s timeout, 50-session scan cap. Read-only; no approval.',
        capabilityClasses: ['read'],
        parametersJsonSchema: sessionSearchParametersJsonSchema,
        inputSchema: sessionSearchInputSchema,
        outputSchema: z.object({
            results: z.array(
                z.object({
                    sessionId: z.string(),
                    messageId: z.string(),
                    role: z.string(),
                    excerpt: z.string(),
                    matchCount: z.number(),
                    timestamp: z.string(),
                }),
            ),
            timedOut: z.boolean(),
            sessionsScanned: z.number(),
            truncated: z.boolean(),
        }),
        outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
        execute: async (input, context) => {
            const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
            return runBoundedSearch(input, limit, options, context.signal);
        },
        toModelOutput: formatSessionSearchModelOutput,
    };
}

async function runBoundedSearch(
    input: SessionSearchInput,
    limit: number,
    options: SessionToolsOptions | undefined,
    signal: AbortSignal,
): Promise<SessionSearchOutput> {
    const deadline = Date.now() + SESSION_SEARCH_TIMEOUT_MS;
    const needle = input.case_sensitive === true ? input.query : input.query.toLowerCase();

    const results: SessionSearchResult[] = [];
    let sessionsScanned = 0;
    let timedOut = false;

    const ids =
        input.session_id !== undefined
            ? [input.session_id]
            : (await listSessionIds(options)).slice(0, MAX_SESSIONS_TO_SCAN);

    for (const sessionId of ids) {
        if (signal.aborted) {
            break;
        }
        if (Date.now() >= deadline) {
            timedOut = true;
            break;
        }
        sessionsScanned += 1;
        const read = await readSessionProjection(sessionId, options);
        if (read.kind !== 'found' || read.projection === undefined) {
            continue;
        }
        for (const message of extractMessages(read.projection)) {
            if (results.length >= limit) {
                break;
            }
            const hit = matchMessage(message.text, needle, input.case_sensitive === true);
            if (hit.matchCount > 0) {
                results.push({
                    sessionId,
                    messageId: message.messageId,
                    role: message.role,
                    excerpt: redactSessionText(hit.excerpt),
                    matchCount: hit.matchCount,
                    timestamp: message.timestamp,
                });
            }
        }
    }

    return {
        results: results.slice(0, limit),
        timedOut,
        sessionsScanned,
        truncated: results.length >= limit && sessionsScanned < ids.length,
    };
}

function matchMessage(
    text: string,
    needle: string,
    caseSensitive: boolean,
): { readonly matchCount: number; readonly excerpt: string } {
    const haystack = caseSensitive ? text : text.toLowerCase();
    if (needle.length === 0 || !haystack.includes(needle)) {
        return { matchCount: 0, excerpt: '' };
    }
    const matchCount = countOccurrences(haystack, needle);
    const index = haystack.indexOf(needle);
    const start = Math.max(0, index - EXCERPT_RADIUS);
    const end = Math.min(text.length, index + needle.length + EXCERPT_RADIUS);
    let excerpt = text.slice(start, end);
    if (start > 0) {
        excerpt = `...${excerpt}`;
    }
    if (end < text.length) {
        excerpt = `${excerpt}...`;
    }
    return { matchCount, excerpt };
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) {
        return 0;
    }
    let count = 0;
    let cursor = 0;
    while (cursor <= haystack.length) {
        const found = haystack.indexOf(needle, cursor);
        if (found === -1) {
            break;
        }
        count += 1;
        cursor = found + needle.length;
    }
    return count;
}
