// clean-room reimplementation of hashline edit-by-hash
// (algorithm inspired by upstream agent harness hashline-core and oh-my-pi hashline;
// reimplemented from scratch in fresh mission-control code, no source
// expression copied). License classification is recorded in
// .mc/evidence/license-matrix.md.
//
// The per-line content hash maps a line's normalized text to a 2-char CID from
// a 16-symbol alphabet. The hash primitive is xxHash32, a public BSD-2-Clause
// algorithm by Yann Collet (github.com/Cyan4973/xxHash); the implementation
// below is written from the public spec and depends only on the JS standard
// library.

// 16-symbol nibble alphabet: index 0..15 -> char. A 2-char CID encodes one byte
// (high nibble + low nibble), giving a 256-entry dictionary.
export const HASHLINE_ALPHABET = 'ZPMQVRWSNKTXJBYH';

// Pre-computed 256-entry dictionary: byte value -> 2-char CID.
export const HASHLINE_DICT: readonly string[] = Array.from({ length: 256 }, (_, value) => {
    const high = value >>> 4;
    const low = value & 0x0f;
    return `${HASHLINE_ALPHABET[high]}${HASHLINE_ALPHABET[low]}`;
});

// Anchor reference: `{line}#{cid}`. Used by hashline_edit to target a line.
export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;

// Tagged read output line: `{line}#{cid}|{content}`.
export const HASHLINE_OUTPUT_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/;

// A line counts as "significant" when it carries a letter or digit; pure
// whitespace / blank lines seed on their position so distinct blank slots
// produce distinct CIDs (otherwise every blank line would collide).
const SIGNIFICANT_CHAR = /\p{L}\p{N}/u;

// --- xxHash32 (public algorithm, fresh implementation) ----------------------

const PRIME_1 = 0x9e3779b1;
const PRIME_2 = 0x85ebca77;
const PRIME_3 = 0xc2b2ae3d;
const PRIME_4 = 0x27d4eb2f;
const PRIME_5 = 0x165667b1;

const encoder = new TextEncoder();

function rotl32(value: number, bits: number): number {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function readU32Le(bytes: Uint8Array, offset: number): number {
    return (
        ((bytes[offset] ?? 0) |
            ((bytes[offset + 1] ?? 0) << 8) |
            ((bytes[offset + 2] ?? 0) << 16) |
            ((bytes[offset + 3] ?? 0) << 24)) >>>
        0
    );
}

function accRound(accumulator: number, lane: number): number {
    const summed = (accumulator + Math.imul(lane, PRIME_2)) >>> 0;
    return Math.imul(rotl32(summed, 13), PRIME_1) >>> 0;
}

function xxHash32(bytes: Uint8Array, seed: number): number {
    const length = bytes.length;
    let offset = 0;
    let hash: number;

    if (length >= 16) {
        const limit = length - 16;
        let v1 = (seed + PRIME_1 + PRIME_2) >>> 0;
        let v2 = (seed + PRIME_2) >>> 0;
        let v3 = seed >>> 0;
        let v4 = (seed - PRIME_1) >>> 0;
        while (offset <= limit) {
            v1 = accRound(v1, readU32Le(bytes, offset));
            offset += 4;
            v2 = accRound(v2, readU32Le(bytes, offset));
            offset += 4;
            v3 = accRound(v3, readU32Le(bytes, offset));
            offset += 4;
            v4 = accRound(v4, readU32Le(bytes, offset));
            offset += 4;
        }
        hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
    } else {
        hash = (seed + PRIME_5) >>> 0;
    }

    hash = (hash + length) >>> 0;

    while (offset + 4 <= length) {
        hash = (hash + Math.imul(readU32Le(bytes, offset), PRIME_3)) >>> 0;
        hash = Math.imul(rotl32(hash, 17), PRIME_4) >>> 0;
        offset += 4;
    }

    while (offset < length) {
        hash = (hash + Math.imul(bytes[offset] ?? 0, PRIME_5)) >>> 0;
        hash = Math.imul(rotl32(hash, 11), PRIME_1) >>> 0;
        offset += 1;
    }

    hash ^= hash >>> 15;
    hash = Math.imul(hash, PRIME_2) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, PRIME_3) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function cidFor(normalizedContent: string, seed: number): string {
    const digest = xxHash32(encoder.encode(normalizedContent), seed);
    return HASHLINE_DICT[digest % 256] ?? HASHLINE_DICT[0] ?? 'ZZ';
}

/**
 * Compute the 2-char content-hash CID for one line. The content is normalized
 * by stripping carriage returns and trailing whitespace before hashing, so CRLF
 * endings and editor-trimmed lines do not invalidate a tag.
 */
export function computeLineHash(lineNumber: number, content: string): string {
    const normalized = content.replace(/\r/g, '').trimEnd();
    const seed = SIGNIFICANT_CHAR.test(normalized) ? 0 : lineNumber;
    return cidFor(normalized, seed);
}

// Legacy normalization strips ALL whitespace; kept so older stored hashes still
// validate when an edit references a tag minted under the looser rule.
export function computeLegacyLineHash(lineNumber: number, content: string): string {
    const normalized = content.replace(/\r/g, '').replace(/\s+/g, '');
    const seed = SIGNIFICANT_CHAR.test(normalized) ? 0 : lineNumber;
    return cidFor(normalized, seed);
}

/** Format a single line as `{line}#{cid}|{content}` for the tagged read view. */
export function formatHashLine(lineNumber: number, content: string): string {
    return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`;
}

/** Format an entire file body into tagged `NN#XX|content` lines. */
export function formatHashLines(content: string): string {
    if (content.length === 0) {
        return '';
    }
    const lines = content.split('\n');
    return lines.map((line, index) => formatHashLine(index + 1, line)).join('\n');
}
