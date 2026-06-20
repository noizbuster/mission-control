// allow: SIZE_OK — faithful port of opencode's cohesive 9-stage fuzzy replacer chain.
// The replacers, levenshtein DP, and the replace() entry point form one indivisible
// algorithm; splitting would break the single-file contract the integration task relies on.
import { createTwoFilesPatch } from 'diff';

/**
 * A replacer yields zero or more candidate strings that might appear in `content`.
 * The `replace()` entry point tries each candidate via indexOf and applies the first
 * that satisfies uniqueness / replaceAll semantics.
 */
export type Replacer = (content: string, find: string) => Generator<string>;

/**
 * Discriminated result of a fuzzy replace attempt. Callers (file-edit-operation)
 * map each status to the appropriate failure code or applied content.
 */
export type FuzzyReplaceResult =
    | { readonly status: 'applied'; readonly result: string; readonly matchedText: string }
    | { readonly status: 'not_found' }
    | { readonly status: 'not_unique' }
    | { readonly status: 'disproportionate'; readonly matchedText: string }
    | { readonly status: 'identical_input' }
    | { readonly status: 'empty_old' };

// Similarity thresholds for block anchor fallback matching.
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

/**
 * Levenshtein edit distance via O(n*m) dynamic programming.
 * Uses the standard two-row memory optimization (identical results, O(min(n,m)) space).
 */
export function levenshtein(a: string, b: string): number {
    if (a === '' || b === '') {
        return Math.max(a.length, b.length);
    }
    let previous: number[] = [];
    for (let j = 0; j <= b.length; j++) {
        previous[j] = j;
    }
    let current: number[] = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        current[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                (previous[j] ?? Number.MAX_SAFE_INTEGER) + 1,
                (current[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
                (previous[j - 1] ?? Number.MAX_SAFE_INTEGER) + cost,
            );
        }
        [previous, current] = [current, previous];
    }
    return previous[b.length] ?? a.length;
}

/**
 * Guards against fuzzy matches swallowing far more content than the model intended.
 * Returns true when the matched span is disproportionately larger than oldString.
 */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
    const oldLines = oldString.split('\n').length;
    const searchLines = search.split('\n').length;
    if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
    if (oldLines === 1) return false;
    return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

/** Yields `find` verbatim — the exact-match baseline tried first. */
export const SimpleReplacer: Replacer = function* (_content, find) {
    yield find;
};

/** Per-line `.trim()` comparison across a sliding window of content lines. */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
    const originalLines = content.split('\n');
    const searchLines = find.split('\n');
    if (searchLines[searchLines.length - 1] === '') {
        searchLines.pop();
    }
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            const originalLine = originalLines[i + j];
            const searchLine = searchLines[j];
            if (originalLine === undefined || searchLine === undefined || originalLine.trim() !== searchLine.trim()) {
                matches = false;
                break;
            }
        }
        if (matches) {
            let matchStartIndex = 0;
            for (let k = 0; k < i; k++) {
                matchStartIndex += (originalLines[k]?.length ?? 0) + 1;
            }
            let matchEndIndex = matchStartIndex;
            for (let k = 0; k < searchLines.length; k++) {
                matchEndIndex += originalLines[i + k]?.length ?? 0;
                if (k < searchLines.length - 1) {
                    matchEndIndex += 1;
                }
            }
            yield content.substring(matchStartIndex, matchEndIndex);
        }
    }
};

/** First + last line anchors with Levenshtein similarity on middle lines (requires 3+ lines). */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
    const originalLines = content.split('\n');
    const searchLines = find.split('\n');
    if (searchLines.length < 3) return;
    if (searchLines[searchLines.length - 1] === '') {
        searchLines.pop();
    }
    const firstSearchLine = searchLines[0];
    const lastSearchLine = searchLines[searchLines.length - 1];
    if (firstSearchLine === undefined || lastSearchLine === undefined) return;
    const firstLineSearch = firstSearchLine.trim();
    const lastLineSearch = lastSearchLine.trim();
    const searchBlockSize = searchLines.length;
    const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

    const candidates: Array<{ startLine: number; endLine: number }> = [];
    for (let i = 0; i < originalLines.length; i++) {
        if (originalLines[i]?.trim() !== firstLineSearch) continue;
        for (let j = i + 2; j < originalLines.length; j++) {
            if (originalLines[j]?.trim() === lastLineSearch) {
                const actualBlockSize = j - i + 1;
                if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
                    candidates.push({ startLine: i, endLine: j });
                }
                break;
            }
        }
    }
    if (candidates.length === 0) return;

    if (candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate === undefined) return;
        const { startLine, endLine } = candidate;
        const actualBlockSize = endLine - startLine + 1;
        let similarity = 0;
        const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
        if (linesToCheck > 0) {
            for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
                const originalLine = originalLines[startLine + j]?.trim() ?? '';
                const searchLine = searchLines[j]?.trim() ?? '';
                const maxLen = Math.max(originalLine.length, searchLine.length);
                if (maxLen === 0) continue;
                const distance = levenshtein(originalLine, searchLine);
                similarity += (1 - distance / maxLen) / linesToCheck;
                if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
            }
        } else {
            similarity = 1.0;
        }
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
            yield sliceLineBlock(content, originalLines, startLine, endLine);
        }
        return;
    }

    let bestMatch: { startLine: number; endLine: number } | null = null;
    let maxSimilarity = -1;
    for (const candidate of candidates) {
        const { startLine, endLine } = candidate;
        const actualBlockSize = endLine - startLine + 1;
        let similarity = 0;
        const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
        if (linesToCheck > 0) {
            for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
                const originalLine = originalLines[startLine + j]?.trim() ?? '';
                const searchLine = searchLines[j]?.trim() ?? '';
                const maxLen = Math.max(originalLine.length, searchLine.length);
                if (maxLen === 0) continue;
                const distance = levenshtein(originalLine, searchLine);
                similarity += 1 - distance / maxLen;
            }
            similarity /= linesToCheck;
        } else {
            similarity = 1.0;
        }
        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            bestMatch = candidate;
        }
    }
    if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
        yield sliceLineBlock(content, originalLines, bestMatch.startLine, bestMatch.endLine);
    }
};

/** Collapses all whitespace runs to single spaces on both sides before comparing. */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
    const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const normalizedFind = normalizeWhitespace(find);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (normalizeWhitespace(line) === normalizedFind) {
            yield line;
        } else {
            const normalizedLine = normalizeWhitespace(line);
            if (normalizedLine.includes(normalizedFind)) {
                const words = find.trim().split(/\s+/);
                if (words.length > 0) {
                    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
                    try {
                        const regex = new RegExp(pattern);
                        const match = line.match(regex);
                        if (match && match[0] !== undefined) {
                            yield match[0];
                        }
                    } catch {
                        // Invalid regex pattern — skip.
                    }
                }
            }
        }
    }
    const findLines = find.split('\n');
    if (findLines.length > 1) {
        for (let i = 0; i <= lines.length - findLines.length; i++) {
            const block = lines.slice(i, i + findLines.length).join('\n');
            if (normalizeWhitespace(block) === normalizedFind) {
                yield block;
            }
        }
    }
};

/** Strips the common minimum indent from both the search and each content window. */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
    const removeIndentation = (text: string): string => {
        const lines = text.split('\n');
        const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
        if (nonEmptyLines.length === 0) return text;
        const minIndent = Math.min(
            ...nonEmptyLines.map((line) => {
                const match = line.match(/^(\s*)/);
                return match?.[1]?.length ?? 0;
            }),
        );
        return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
    };
    const normalizedFind = removeIndentation(find);
    const contentLines = content.split('\n');
    const findLines = find.split('\n');
    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
        const block = contentLines.slice(i, i + findLines.length).join('\n');
        if (removeIndentation(block) === normalizedFind) {
            yield block;
        }
    }
};

/** Decodes common escape sequences (`\n`, `\t`, `\\`, etc.) in `find` before matching. */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
    const unescapeString = (str: string): string =>
        str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match: string, capturedChar: string): string => {
            switch (capturedChar) {
                case 'n':
                    return '\n';
                case 't':
                    return '\t';
                case 'r':
                    return '\r';
                case "'":
                    return "'";
                case '"':
                    return '"';
                case '`':
                    return '`';
                case '\\':
                    return '\\';
                case '\n':
                    return '\n';
                case '$':
                    return '$';
                default:
                    return match;
            }
        });
    const unescapedFind = unescapeString(find);
    if (content.includes(unescapedFind)) {
        yield unescapedFind;
    }
    const lines = content.split('\n');
    const findLines = unescapedFind.split('\n');
    for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join('\n');
        if (unescapeString(block) === unescapedFind) {
            yield block;
        }
    }
};

/** Yields every indexOf occurrence of `find` — drives the replaceAll path. */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
    let startIndex = 0;
    while (true) {
        const index = content.indexOf(find, startIndex);
        if (index === -1) break;
        yield find;
        startIndex = index + find.length;
    }
};

/** Direct trimmed match when `find.trim()` differs from `find` (stray blank-line padding). */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
    const trimmedFind = find.trim();
    if (trimmedFind === find) return;
    if (content.includes(trimmedFind)) {
        yield trimmedFind;
    }
    const lines = content.split('\n');
    const findLines = find.split('\n');
    for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join('\n');
        if (block.trim() === trimmedFind) {
            yield block;
        }
    }
};

/** First + last line anchors with 50% exact trimmed middle-line requirement (requires 3+ lines). */
export const ContextAwareReplacer: Replacer = function* (content, find) {
    const findLines = find.split('\n');
    if (findLines.length < 3) return;
    if (findLines[findLines.length - 1] === '') {
        findLines.pop();
    }
    const contentLines = content.split('\n');
    const firstFindLine = findLines[0];
    const lastFindLine = findLines[findLines.length - 1];
    if (firstFindLine === undefined || lastFindLine === undefined) return;
    const firstLine = firstFindLine.trim();
    const lastLine = lastFindLine.trim();
    for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i]?.trim() !== firstLine) continue;
        for (let j = i + 2; j < contentLines.length; j++) {
            if (contentLines[j]?.trim() === lastLine) {
                const blockLines = contentLines.slice(i, j + 1);
                if (blockLines.length === findLines.length) {
                    let matchingLines = 0;
                    let totalNonEmptyLines = 0;
                    for (let k = 1; k < blockLines.length - 1; k++) {
                        const blockLine = blockLines[k]?.trim() ?? '';
                        const searchLine = findLines[k]?.trim() ?? '';
                        if (blockLine.length > 0 || searchLine.length > 0) {
                            totalNonEmptyLines++;
                            if (blockLine === searchLine) matchingLines++;
                        }
                    }
                    if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
                        yield blockLines.join('\n');
                        break;
                    }
                }
                break;
            }
        }
    }
};

/** Ordered list of replacers tried by `replace()`, first match wins. */
const REPLACERS: readonly Replacer[] = [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
];

/**
 * Entry point: tries each replacer in order, applies the disproportionate-match guard,
 * and handles uniqueness checking for non-replaceAll mode.
 */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): FuzzyReplaceResult {
    if (oldString === newString) {
        return { status: 'identical_input' };
    }
    if (oldString === '') {
        return { status: 'empty_old' };
    }
    let notFound = true;
    for (const replacer of REPLACERS) {
        for (const search of replacer(content, oldString)) {
            const index = content.indexOf(search);
            if (index === -1) continue;
            notFound = false;
            if (isDisproportionateMatch(search, oldString)) {
                return { status: 'disproportionate', matchedText: search };
            }
            if (replaceAll) {
                return { status: 'applied', result: content.replaceAll(search, newString), matchedText: search };
            }
            const lastIndex = content.lastIndexOf(search);
            if (index !== lastIndex) continue;
            return {
                status: 'applied',
                result: content.substring(0, index) + newString + content.substring(index + search.length),
                matchedText: search,
            };
        }
    }
    if (notFound) {
        return { status: 'not_found' };
    }
    return { status: 'not_unique' };
}

/** Renders a unified-diff string for a replacement using the `diff` package. */
export function renderUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
    return createTwoFilesPatch(filePath, filePath, oldContent, newContent);
}

// --- Internal helpers ---

/** Slices `content` from the start of `startLine` to the end of `endLine` (inclusive). */
function sliceLineBlock(content: string, lines: readonly string[], startLine: number, endLine: number): string {
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
        matchStartIndex += (lines[k]?.length ?? 0) + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += lines[k]?.length ?? 0;
        if (k < endLine) matchEndIndex += 1;
    }
    return content.substring(matchStartIndex, matchEndIndex);
}
