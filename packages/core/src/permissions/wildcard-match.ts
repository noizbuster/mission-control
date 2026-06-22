/**
 * Glob-style wildcard matching for policy-gate permission rules.
 *
 * Semantics:
 * - `*` matches any characters within a single path segment (does not cross `/`).
 * - `**` matches zero or more complete path segments (crosses `/` recursively).
 * - `?` matches a single character within a segment.
 * - All other characters match literally.
 *
 * Ported from `temp/ref-repos/opencode/packages/opencode/src/util/wildcard.ts` with
 * corrected glob semantics: the original used `.*` for `*` (matching across `/`),
 * which does not match standard glob conventions. This implementation is segment-based
 * so `*` stays within a segment and `**` spans segments.
 */

/**
 * Match `value` against a glob `pattern`.
 *
 * Both inputs are normalized to forward slashes before matching. The pattern is
 * split into segments by `/`; each segment is matched literally except for `*`
 * (any chars within the segment) and `?` (single char within the segment). The
 * `**` segment matches zero or more value segments.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
    const normalizedPattern = pattern.replaceAll('\\', '/');
    const normalizedValue = value.replaceAll('\\', '/');

    if (normalizedPattern.length === 0) {
        return normalizedValue.length === 0;
    }

    const patternSegs = normalizedPattern.split('/');
    const valueSegs = normalizedValue.split('/');
    return matchSegments(patternSegs, valueSegs);
}

function matchSegments(patternSegs: readonly string[], valueSegs: readonly string[]): boolean {
    if (patternSegs.length === 0) {
        return valueSegs.length === 0;
    }

    const head = patternSegs[0];
    if (head === undefined) {
        return false;
    }
    const rest = patternSegs.slice(1);

    if (head === '**') {
        for (let consumed = 0; consumed <= valueSegs.length; consumed++) {
            if (matchSegments(rest, valueSegs.slice(consumed))) {
                return true;
            }
        }
        return false;
    }

    if (valueSegs.length === 0) {
        return false;
    }

    const valueHead = valueSegs[0];
    if (valueHead === undefined) {
        return false;
    }
    return matchSegment(head, valueHead) && matchSegments(rest, valueSegs.slice(1));
}

function matchSegment(patternSeg: string, valueSeg: string): boolean {
    const regexSource = patternSeg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexSource}$`).test(valueSeg);
}
