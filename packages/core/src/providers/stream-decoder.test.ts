import { describe, expect, it } from 'vitest';
import { createStreamDecoder, truncateToValidUtf8Boundary } from './stream-decoder.js';
import { Buffer } from 'node:buffer';

describe('createStreamDecoder', () => {
    it('passes string chunks through unchanged', () => {
        const decoder = createStreamDecoder();
        expect(decoder.decode('hello')).toBe('hello');
        expect(decoder.flush()).toBe('');
    });

    it('decodes ASCII buffers correctly', () => {
        const decoder = createStreamDecoder();
        expect(decoder.decode(Buffer.from('hello', 'utf8'))).toBe('hello');
        expect(decoder.flush()).toBe('');
    });

    it('does not corrupt a Korean Hangul syllable split across two chunks', () => {
        const koreanBytes = Buffer.from('이', 'utf8');
        expect(koreanBytes).toHaveLength(3);
        const decoder = createStreamDecoder();
        const firstPart = decoder.decode(koreanBytes.subarray(0, 1));
        const secondPart = decoder.decode(koreanBytes.subarray(1));
        const flushed = decoder.flush();
        expect(firstPart).toBe('');
        expect(secondPart + flushed).toBe('이');
    });

    it('reproduces and fixes the user-reported Korean garbling bug', () => {
        const original = '오버레이 표시 상태';
        const bytes = Buffer.from(original, 'utf8');
        const decoder = createStreamDecoder();
        let reconstructed = '';
        for (let i = 0; i < bytes.length; i += 1) {
            reconstructed += decoder.decode(Buffer.from([bytes[i]!]));
        }
        reconstructed += decoder.flush();
        expect(reconstructed).toBe(original);
        expect(reconstructed).not.toContain('\uFFFD');
    });

    it('handles a realistic SSE-style chunk pattern where boundaries land mid-codepoint', () => {
        const text = 'Hello 안녕하세요 🇰🇷 World';
        const bytes = Buffer.from(text, 'utf8');
        const decoder = createStreamDecoder();
        let result = '';
        // Simulate ~512-byte TCP chunks
        const chunkSize = 4;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            result += decoder.decode(bytes.subarray(i, i + chunkSize));
        }
        result += decoder.flush();
        expect(result).toBe(text);
        expect(result).not.toContain('\uFFFD');
    });

    it('returns an empty string from flush when no bytes are pending', () => {
        const decoder = createStreamDecoder();
        expect(decoder.flush()).toBe('');
    });

    it('handles Uint8Array chunks (not just Buffer)', () => {
        const decoder = createStreamDecoder();
        const bytes = new Uint8Array([0xeb, 0xa0, 0x88]);
        expect(decoder.decode(bytes)).toBe('레');
        expect(decoder.flush()).toBe('');
    });

    it('handles mixed string and Buffer chunks', () => {
        const decoder = createStreamDecoder();
        let result = decoder.decode('오버레');
        result += decoder.decode(Buffer.from('이', 'utf8'));
        result += decoder.flush();
        expect(result).toBe('오버레이');
    });
});

describe('truncateToValidUtf8Boundary', () => {
    it('returns the buffer unchanged when maxBytes >= buf.length and buffer is valid', () => {
        const buf = Buffer.from('hello', 'utf8');
        expect(truncateToValidUtf8Boundary(buf, 10)).toEqual(buf);
    });

    it('cuts on a valid boundary when maxBytes splits a Korean Hangul syllable', () => {
        // '오버레이' = [EC 98 A4] [EB B2 84] [EB A0 88] [EC 9D B4] = 12 bytes
        const buf = Buffer.from('오버레이', 'utf8');
        // Cut at 10 bytes: first 3 syllables (9 bytes) + 1 byte of 4th syllable
        const truncated = truncateToValidUtf8Boundary(buf, 10);
        expect(truncated.toString('utf8')).toBe('오버레');
        expect(truncated.length).toBe(9);
        expect(truncated.toString('utf8')).not.toContain('\uFFFD');
    });

    it('includes a complete Korean syllable when maxBytes lands on its boundary', () => {
        const buf = Buffer.from('오버레이', 'utf8');
        // Cut at 9 bytes = exactly 3 complete syllables
        const truncated = truncateToValidUtf8Boundary(buf, 9);
        expect(truncated.toString('utf8')).toBe('오버레');
    });

    it('cuts on a valid boundary when maxBytes splits an emoji', () => {
        const buf = Buffer.from('a😀b', 'utf8');
        // 'a' = 1 byte, '😀' = 4 bytes (F0 9F 98 80), 'b' = 1 byte = total 6
        const truncated = truncateToValidUtf8Boundary(buf, 3);
        expect(truncated.toString('utf8')).toBe('a');
        expect(truncated.toString('utf8')).not.toContain('\uFFFD');
    });

    it('trims trailing incomplete sequence when buffer itself is truncated mid-stream', () => {
        // '이' = EC 9D B4; keep only first 2 bytes (incomplete)
        const incomplete = Buffer.from([0xec, 0x9d]);
        const result = truncateToValidUtf8Boundary(incomplete, 10);
        expect(result.length).toBe(0);
    });

    it('preserves a complete trailing sequence in a buffer that is shorter than maxBytes', () => {
        const buf = Buffer.from('안녕', 'utf8');
        const result = truncateToValidUtf8Boundary(buf, 100);
        expect(result.toString('utf8')).toBe('안녕');
    });
});
