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
