/**
 * Stateful UTF-8 chunk decoder for HTTP response streams. Buffers incomplete
 * multi-byte sequences across chunks so that a TCP packet boundary splitting
 * a Korean Hangul syllable (3 bytes), CJK character (3 bytes), or emoji
 * (4 bytes) does not corrupt the character into U+FFFD replacement characters.
 *
 * The raw `Buffer.toString('utf8')` call on each stream chunk independently
 * decodes its bytes; any incomplete trailing sequence becomes U+FFFD and the
 * orphaned continuation bytes in the next chunk become a second U+FFFD.
 * `TextDecoder` with `{ stream: true }` buffers the incomplete bytes and
 * completes them on the next call.
 *
 * Usage:
 *   const decoder = createStreamDecoder();
 *   for await (const chunk of response) {
 *       buffer += decoder.decode(chunk);
 *   }
 *   buffer += decoder.flush();
 */

export type StreamDecoder = {
    readonly decode: (chunk: unknown) => string;
    readonly flush: () => string;
};

export function createStreamDecoder(): StreamDecoder {
    const decoder = new TextDecoder();
    return {
        decode(chunk: unknown): string {
            if (typeof chunk === 'string') {
                return chunk;
            }
            if (Buffer.isBuffer(chunk)) {
                return decoder.decode(chunk, { stream: true });
            }
            if (chunk instanceof Uint8Array) {
                return decoder.decode(chunk, { stream: true });
            }
            return String(chunk);
        },
        flush(): string {
            return decoder.decode();
        },
    };
}

/**
 * Truncate `buf` to at most `maxBytes` bytes on a valid UTF-8 codepoint boundary.
 * If `maxBytes` would split a multi-byte character (Korean Hangul, CJK, emoji),
 * the cut walks backward past the incomplete sequence so the returned subarray
 * decodes cleanly with no U+FFFD. Also handles a buffer that itself ends with
 * an incomplete trailing sequence (e.g. truncated mid-stream by a byte cap).
 */
export function truncateToValidUtf8Boundary(buf: Buffer, maxBytes: number): Buffer {
    if (maxBytes >= buf.length) {
        return trimTrailingIncompleteUtf8(buf);
    }
    let cut = maxBytes;
    while (cut > 0) {
        const byte = buf[cut];
        if (byte === undefined || (byte & 0xc0) !== 0x80) break;
        cut--;
    }
    return buf.subarray(0, cut);
}

function trimTrailingIncompleteUtf8(buf: Buffer): Buffer {
    let end = buf.length;
    while (end > 0) {
        const byte = buf[end - 1];
        if (byte === undefined || byte < 0x80) break;
        if ((byte & 0xc0) === 0x80) {
            end--;
            continue;
        }
        const seqLen = byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
        if (end - 1 + seqLen <= buf.length) {
            end = end - 1 + seqLen;
            break;
        }
        end--;
        break;
    }
    return end === buf.length ? buf : buf.subarray(0, end);
}
