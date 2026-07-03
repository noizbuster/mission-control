import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createStreamDecoder } from './stream-decoder.js';

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
