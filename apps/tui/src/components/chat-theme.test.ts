import { describe, expect, it } from 'vitest';
import { buildInlineToolLabel, CHAT_ELEMENT_BG, CHAT_PANEL_BG, CHAT_PRIMARY, toolIconForTitle } from './chat-theme';

describe('chat-theme tokens', () => {
    it('keeps OpenCode dark-step primary and panel fills', () => {
        expect(CHAT_PRIMARY).toBe('#fab283');
        expect(CHAT_PANEL_BG).toBe('#141414');
        expect(CHAT_ELEMENT_BG).toBe('#1e1e1e');
    });
});

describe('toolIconForTitle', () => {
    it('maps common tool titles to OpenCode-style glyphs', () => {
        expect(toolIconForTitle('bash.run')).toBe('$');
        expect(toolIconForTitle('Command output for bash.run')).toBe('$');
        expect(toolIconForTitle('repo.read')).toBe('→');
        expect(toolIconForTitle('file.edit')).toBe('←');
        expect(toolIconForTitle('file.patch')).toBe('←');
        expect(toolIconForTitle('repo.search')).toBe('✱');
        expect(toolIconForTitle('webfetch')).toBe('%');
        expect(toolIconForTitle('task')).toBe('◉');
        expect(toolIconForTitle('todowrite')).toBe('☐');
        expect(toolIconForTitle('skill')).toBe('★');
    });

    it('falls back to the gear icon for unknown titles', () => {
        expect(toolIconForTitle(undefined)).toBe('⚙');
        expect(toolIconForTitle('')).toBe('⚙');
        expect(toolIconForTitle('mystery')).toBe('⚙');
    });
});

describe('buildInlineToolLabel', () => {
    it('uses the same plain title for collapsed and expanded tool rows', () => {
        expect(buildInlineToolLabel('file.edit')).toBe('file.edit');
    });

    it('falls back to a generic label when title is undefined', () => {
        expect(buildInlineToolLabel(undefined)).toBe('Tool output');
    });
});
