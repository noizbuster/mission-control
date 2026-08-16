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
    // Memo table over (patternIdx, valueIdx) states. The `**` branch retries its
    // tail against every remaining suffix, so without memoization k `**`
    // segments cost ~C(n+k, k) re-evaluations — exponential in the number of
    // `**` segments, which an adversarial pattern can turn into a hang. With the
    // table the matcher is bounded by O(patternSegs.length × valueSegs.length)
    // states (each `**` state additionally scans the remaining value segments).
    const width = valueSegs.length + 1;
    const memo = new Map<number, boolean>();
    const matchFrom = (patternIdx: number, valueIdx: number): boolean => {
        const key = patternIdx * width + valueIdx;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;

        let matched = false;
        if (patternIdx === patternSegs.length) {
            matched = valueIdx === valueSegs.length;
        } else {
            const head = patternSegs[patternIdx];
            if (head === '**') {
                for (let consumed = valueIdx; consumed <= valueSegs.length; consumed++) {
                    if (matchFrom(patternIdx + 1, consumed)) {
                        matched = true;
                        break;
                    }
                }
            } else if (head !== undefined && valueIdx < valueSegs.length) {
                const valueHead = valueSegs[valueIdx];
                if (valueHead !== undefined) {
                    matched = matchSegment(head, valueHead) && matchFrom(patternIdx + 1, valueIdx + 1);
                }
            }
        }

        memo.set(key, matched);
        return matched;
    };
    return matchFrom(0, 0);
}

/**
 * Cache of compiled segment regexes, keyed on the raw pattern segment string.
 * The compiled `regexSource` is a pure function of the segment, so keying on
 * the segment is equivalent to keying on the derived source but avoids a second
 * string allocation per miss.
 *
 * Bounded by distinct-segment cardinality: the segments reaching this cache are
 * permission-rule pattern fragments, which are static config fixed at startup.
 * There is no runtime path that injects unbounded distinct segments, so module-
 * lifetime caching without LRU eviction is safe. Regexes are non-global, so
 * `lastIndex` stays `0` and cached instances are safe to reuse across calls.
 */
const segmentRegexCache = new Map<string, RegExp>();

function compileSegmentRegex(patternSeg: string): RegExp {
    const regexSource = patternSeg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexSource}$`);
}

function matchSegment(patternSeg: string, valueSeg: string): boolean {
    let regex = segmentRegexCache.get(patternSeg);
    if (regex === undefined) {
        regex = compileSegmentRegex(patternSeg);
        segmentRegexCache.set(patternSeg, regex);
    }
    return regex.test(valueSeg);
}

/**
 * Test-only: the number of distinct segment patterns currently cached.
 */
export function _testRegexCacheSize(): number {
    return segmentRegexCache.size;
}

/**
 * Test-only: clears the segment regex cache so segments accumulated by prior
 * tests do not mask cache-growth regressions.
 */
export function _testResetRegexCache(): void {
    segmentRegexCache.clear();
}
