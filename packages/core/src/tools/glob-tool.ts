/**
 * `glob` tool — fast path finder (opencode/pi surface, Phase 4).
 *
 * Resolves a glob pattern (`*` within a path segment, `**` across segments) to matching file
 * paths under a base directory, using Node's recursive readdir (no external glob dependency).
 * Output is bounded with a continuation hint when truncated.
 */

import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types.js';
import { truncateOutput, withContinuationHint } from './truncate.js';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const DEFAULT_MAX_RESULTS = 100;
const OUTPUT_LIMIT_CHARS = 4000;

const globInputSchema = z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().positive().optional(),
});
export type GlobToolInput = z.infer<typeof globInputSchema>;

const globOutputSchema = z.object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
});
export type GlobToolOutput = z.infer<typeof globOutputSchema>;

export const globToolRegistration: ToolRegistration<GlobToolInput, GlobToolOutput> = {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/*.json"). Returns matching paths.',
    capabilityClasses: ['read'],
    parametersJsonSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Glob pattern. `*` matches within a segment; `**` matches across segments.',
            },
            path: { type: 'string', description: 'Base directory to search from. Defaults to the workspace root.' },
            maxResults: { type: 'integer', description: `Maximum paths to return (default ${DEFAULT_MAX_RESULTS}).` },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    inputSchema: globInputSchema,
    outputSchema: globOutputSchema,
    outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
    execute: async (input) => {
        const base = resolveBase(input.path);
        const max = input.maxResults ?? DEFAULT_MAX_RESULTS;
        const matcher = globToRegExp(input.pattern);
        const entries = await safeReaddirRecursive(base);
        const matches: string[] = [];
        for (const entry of entries) {
            const rel = relative(base, entry).split(sep).join('/');
            if (matcher.test(rel)) {
                matches.push(rel);
                if (matches.length >= max) {
                    break;
                }
            }
        }
        matches.sort();
        return { paths: matches, truncated: matches.length >= max };
    },
    toModelOutput: (output) => {
        if (output.paths.length === 0) {
            return 'No files matched the pattern.';
        }
        const body = output.paths.join('\n');
        const truncated = truncateOutput(body, OUTPUT_LIMIT_CHARS - 64);
        return withContinuationHint(
            truncated,
            output.truncated ? 'narrow the pattern or raise maxResults for more' : '',
        );
    },
};

function resolveBase(path: string | undefined): string {
    if (path === undefined || path.length === 0) {
        return process.cwd();
    }
    return isAbsolute(path) ? path : join(process.cwd(), path);
}

async function safeReaddirRecursive(base: string): Promise<readonly string[]> {
    try {
        const entries = await readdir(base, { recursive: true, withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) =>
                entry.parentPath !== undefined && entry.parentPath !== ''
                    ? join(entry.parentPath, entry.name)
                    : entry.name,
            );
    } catch {
        return [];
    }
}

/** Convert a glob pattern (`*`, `**`, `?`) to a RegExp anchoring the whole string. */
function globToRegExp(pattern: string): RegExp {
    let regex = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (char === undefined) {
            break;
        }
        if (char === '*') {
            const next = pattern[index + 1];
            if (next === '*') {
                regex += '.*';
                index += 1;
                if (pattern[index + 1] === '/') {
                    index += 1;
                }
            } else {
                regex += '[^/]*';
            }
        } else if (char === '?') {
            regex += '[^/]';
        } else if (isRegExpSpecial(char)) {
            regex += `\\${char}`;
        } else {
            regex += char;
        }
    }
    return new RegExp(`${regex}$`);
}

function isRegExpSpecial(char: string): boolean {
    return '.+()|{}[]^$\\'.includes(char);
}
