/**
 * Internal `://` scheme registry.
 *
 * Shared schemas and the URL parser for the internal scheme resolver
 * (pr/issue/agent/skill/rule/conflict). Values crossing the core/tools
 * boundary live here so the resolver middleware, the read/webfetch/write
 * interceptors, and tests share one contract. The runtime handlers and
 * injectable backends live in `@mission-control/core`; this module is
 * schema + parse only.
 *
 * Ported from oh-my-pi `internal-urls` (MIT, Can Boeluek / Mario Zechner):
 * the parser preserves host casing (so `skill://plugin:name` survives) and
 * rejects `new URL()` port-separator assumptions for namespaced hosts.
 */
import { z } from 'zod';

/**
 * Schemes the internal resolver recognises. The set is intentionally
 * narrow: each entry has a dedicated, injectable backend in core. Unknown
 * schemes surface as a clear error rather than a silent network fetch.
 */
export const INTERNAL_SCHEME_NAMES = ['pr', 'issue', 'agent', 'skill', 'rule', 'conflict'] as const;
export type InternalSchemeName = (typeof INTERNAL_SCHEME_NAMES)[number];
export const InternalSchemeNameSchema = z.enum(INTERNAL_SCHEME_NAMES);

export const INTERNAL_SCHEME_CONTENT_TYPES = ['text/markdown', 'application/json', 'text/plain'] as const;
export type InternalSchemeContentType = (typeof INTERNAL_SCHEME_CONTENT_TYPES)[number];
export const InternalSchemeContentTypeSchema = z.enum(INTERNAL_SCHEME_CONTENT_TYPES);

/**
 * Resolved resource returned by a scheme handler. Mirrors the oh-my-pi
 * `InternalResource` shape: `content` is the model-facing text, `contentType`
 * tells callers how to render it, and `immutable` suppresses edit anchors.
 */
export const InternalSchemeResourceSchema = z
    .object({
        url: z.string().min(1),
        content: z.string(),
        contentType: InternalSchemeContentTypeSchema,
        size: z.number().int().nonnegative().optional(),
        sourcePath: z.string().min(1).optional(),
        notes: z.array(z.string()).optional(),
        immutable: z.boolean().optional(),
    })
    .strict();
export type InternalSchemeResource = z.infer<typeof InternalSchemeResourceSchema>;

/**
 * Parsed internal scheme URL. `rawHost` preserves the original casing of the
 * host segment (decoded), since `new URL()` lowercases it and treats a colon
 * as a port separator, breaking namespaced hosts like `skill://plugin:name`.
 */
export interface InternalSchemeUrl {
    /** Lower-cased scheme, no trailing `://`. */
    readonly scheme: string;
    /** Raw host segment, URI-decoded, original casing preserved. */
    readonly rawHost: string;
    /** Path portion (may be empty); query and hash stripped. */
    readonly pathname: string;
    /** Parsed query string (empty when absent). */
    readonly searchParams: URLSearchParams;
    /** The original input string. */
    readonly href: string;
}

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;

/**
 * Parse an internal scheme URL into a typed {@link InternalSchemeUrl}.
 *
 * Handles namespaced hosts (`skill://plugin:name`) where `new URL()` would
 * either fail or misinterpret the colon as a port separator. Does NOT
 * validate that the scheme is registered — callers resolve that against
 * {@link INTERNAL_SCHEME_NAMES} or the resolver's registry.
 *
 * @throws Error when `input` has no `scheme://` prefix.
 */
export function parseInternalSchemeUrl(input: string): InternalSchemeUrl {
    const hostMatch = input.match(SCHEME_HOST_RE);
    if (hostMatch === null || hostMatch[1] === undefined) {
        throw new Error(`Not an internal scheme URL: ${input}`);
    }
    const scheme = hostMatch[1].toLowerCase();
    const rawHostEncoded = hostMatch[2] ?? '';
    let rawHost = rawHostEncoded;
    try {
        rawHost = decodeURIComponent(rawHostEncoded);
    } catch {
        // Leave rawHost as the encoded form when decoding fails.
    }
    const pathMatch = input.match(PATHNAME_RE);
    const pathname = pathMatch?.[1] ?? '';
    const hashIdx = input.indexOf('#');
    const withoutHash = hashIdx !== -1 ? input.slice(0, hashIdx) : input;
    const queryIdx = withoutHash.indexOf('?');
    const queryString = queryIdx !== -1 ? withoutHash.slice(queryIdx + 1) : '';
    return {
        scheme,
        rawHost,
        pathname,
        searchParams: new URLSearchParams(queryString),
        href: input,
    };
}

/**
 * Quick test for a registered internal scheme prefix. Used by interceptors
 * to decide whether to short-circuit a read/webfetch/write before the normal
 * filesystem/network path runs.
 */
export function isInternalSchemeInput(input: string): boolean {
    const match = input.match(SCHEME_HOST_RE);
    if (match === null || match[1] === undefined) {
        return false;
    }
    return (INTERNAL_SCHEME_NAMES as readonly string[]).includes(match[1].toLowerCase());
}
