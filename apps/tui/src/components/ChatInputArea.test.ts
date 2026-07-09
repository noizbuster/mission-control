import { describe, expect, it } from 'vitest';
import { fileCompletionFrecencyKey } from './ChatInputArea.js';

describe('ChatInputArea prompt-service helpers', () => {
    it('normalizes completed file paths before recording frecency', () => {
        expect(fileCompletionFrecencyKey('README.md')).toBe('README.md');
        expect(fileCompletionFrecencyKey('packages/')).toBe('packages');
    });
});
