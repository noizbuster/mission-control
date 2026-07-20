// clean-room reimplementation of hashline edit-by-hash
// (algorithm inspired by upstream agent harness hashline-core and oh-my-pi hashline;
// reimplemented from scratch in fresh mission-control code, no source
// expression copied). License classification is recorded in
// .omo/evidence/license-matrix.md.

import { computeLegacyLineHash, computeLineHash, HASHLINE_REF_PATTERN } from './hash-computation';

export interface LineRef {
    readonly line: number;
    readonly hash: string;
}

const EXTRACT_PATTERN = /([0-9]+#[ZPMQVRWSNKTXJBYH]{2})/;
const MISMATCH_CONTEXT = 2;

// Tolerant normalization: models often echo a diff/quote prefix or paste the
// whole tagged read line. Strip diff sigils, collapse stray spaces around the
// `#`, drop a trailing `|content` echo, then fall back to extracting the first
// well-formed `{line}#{cid}` fragment.
export function normalizeLineRef(ref: string): string {
    const asTrimmed = ref.trim();
    let candidate = asTrimmed;
    candidate = candidate.replace(/^(?:>>>|[+-])\s*/, '');
    candidate = candidate.replace(/\s*#\s*/, '#');
    candidate = candidate.replace(/\|.*$/, '');
    candidate = candidate.trim();
    if (HASHLINE_REF_PATTERN.test(candidate)) {
        return candidate;
    }
    const extracted = candidate.match(EXTRACT_PATTERN);
    if (extracted !== null) {
        return extracted[1] ?? asTrimmed;
    }
    return asTrimmed;
}

export function parseLineRef(ref: string): LineRef {
    const normalized = normalizeLineRef(ref);
    const match = normalized.match(HASHLINE_REF_PATTERN);
    if (match !== null) {
        return { line: Number.parseInt(match[1] ?? '0', 10), hash: match[2] ?? '' };
    }
    const hashIndex = normalized.indexOf('#');
    if (hashIndex > 0) {
        const prefix = normalized.slice(0, hashIndex);
        const suffix = normalized.slice(hashIndex + 1);
        if (!/^\d+$/.test(prefix) && /^[ZPMQVRWSNKTXJBYH]{2}$/.test(suffix)) {
            throw new Error(
                `Invalid line reference: "${ref}". "${prefix}" is not a line number. ` +
                    `Use the line number from the tagged read output.`,
            );
        }
    }
    throw new Error(`Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}"`);
}

function hashMatches(line: number, content: string, hash: string): boolean {
    return computeLineHash(line, content) === hash || computeLegacyLineHash(line, content) === hash;
}

interface MismatchedRef {
    readonly line: number;
    readonly expected: string;
}

export class HashlineMismatchError extends Error {
    /** Expected ref -> current ref, for each mismatched anchor. */
    readonly remaps: ReadonlyMap<string, string>;

    constructor(mismatches: readonly MismatchedRef[], fileLines: readonly string[]) {
        super(formatMismatchMessage(mismatches, fileLines));
        this.name = 'HashlineMismatchError';
        const remaps = new Map<string, string>();
        for (const mismatch of mismatches) {
            const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? '');
            remaps.set(`${mismatch.line}#${mismatch.expected}`, `${mismatch.line}#${actual}`);
        }
        this.remaps = remaps;
    }
}

function formatMismatchMessage(mismatches: readonly MismatchedRef[], fileLines: readonly string[]): string {
    const byLine = new Map<number, MismatchedRef>();
    for (const mismatch of mismatches) {
        byLine.set(mismatch.line, mismatch);
    }
    const display = new Set<number>();
    for (const mismatch of mismatches) {
        const low = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
        const high = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
        for (let line = low; line <= high; line += 1) {
            display.add(line);
        }
    }
    const sorted = [...display].sort((left, right) => left - right);
    const out: string[] = [];
    const noun = mismatches.length === 1 ? ' line has' : ' lines have';
    out.push(
        `${mismatches.length}${noun} changed since last read. ` +
            'Use the updated {line_number}#{hash_id} references below (>>> marks changed lines).',
    );
    out.push('');
    let previous = -1;
    for (const line of sorted) {
        if (previous !== -1 && line > previous + 1) {
            out.push('    ...');
        }
        previous = line;
        const content = fileLines[line - 1] ?? '';
        const hash = computeLineHash(line, content);
        const tagged = `${line}#${hash}|${content}`;
        out.push(byLine.has(line) ? `>>> ${tagged}` : `    ${tagged}`);
    }
    return out.join('\n');
}

function suggestForHash(ref: string, lines: readonly string[]): string | null {
    const match = ref.trim().match(/#([ZPMQVRWSNKTXJBYH]{2})$/);
    if (match === null) {
        return null;
    }
    const hash = match[1] ?? '';
    for (let index = 0; index < lines.length; index += 1) {
        if (hashMatches(index + 1, lines[index] ?? '', hash)) {
            return `Did you mean "${index + 1}#${computeLineHash(index + 1, lines[index] ?? '')}"?`;
        }
    }
    return null;
}

function parseWithHint(ref: string, lines: readonly string[]): LineRef {
    try {
        return parseLineRef(ref);
    } catch (error) {
        const hint = suggestForHash(ref, lines);
        if (hint !== null && error instanceof Error) {
            throw new Error(`${error.message} ${hint}`);
        }
        throw error;
    }
}

/**
 * Validate every LINE#ID reference against the current file content. Throws a
 * {@link HashlineMismatchError} (with a context diff and corrected refs) when a
 * referenced line no longer hashes to its stored CID — the stale-anchor signal
 * that blocks a write before it can corrupt the file.
 */
export function validateLineRefs(lines: readonly string[], refs: readonly string[]): void {
    const mismatches: MismatchedRef[] = [];
    for (const ref of refs) {
        const { line, hash } = parseWithHint(ref, lines);
        if (line < 1 || line > lines.length) {
            throw new Error(`Line number ${line} out of bounds (file has ${lines.length} lines).`);
        }
        const content = lines[line - 1] ?? '';
        if (!hashMatches(line, content, hash)) {
            mismatches.push({ line, expected: hash });
        }
    }
    if (mismatches.length > 0) {
        throw new HashlineMismatchError(mismatches, lines);
    }
}
