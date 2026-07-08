import { defaultTextareaKeyBindings } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { ChatInputTextarea, ChatInputTextareaBase } from './ChatInputTextarea.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readTextareaSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatInputTextarea.tsx'), 'utf8');
}

describe('ChatInputTextarea', () => {
    describe('component seam', () => {
        it('exports the callable Solid component aliases', () => {
            expect(ChatInputTextarea).toBe(ChatInputTextareaBase);
            expect(typeof ChatInputTextareaBase).toBe('function');
        });
    });

    describe('frame', () => {
        it('keeps the full-width left and right input frame so wrapped prompt rows align', () => {
            const source = readTextareaSource();

            expect(source).toContain("border={['left', 'right']}");
            expect(source).toContain('width="100%"');
            expect(source).toContain('flexGrow={1}');
        });
    });

    describe('textarea handle contract', () => {
        it('reads content from textareaRef.get().plainText and falls back to an empty string', () => {
            const source = readTextareaSource();

            expect(source).toContain("const text = textareaRef.get()?.plainText ?? '';");
            expect(source).toContain('onContentChange(text);');
        });

        it('uses a Solid callback ref to update the production handle shape', () => {
            const source = readTextareaSource();

            expect(source).toContain('ref={(renderable: TextareaRenderable) => textareaRef.set(renderable)}');
            expect(source).not.toContain('.current');
        });
    });

    describe('disabled key guard', () => {
        it('prevents default and returns before forwarding when disabled', () => {
            const source = readTextareaSource();
            const disabledBlock = source.slice(
                source.indexOf('const handleKeyDown'),
                source.indexOf('const cursorColor'),
            );

            expect(disabledBlock).toContain('if (disabled)');
            expect(disabledBlock).toContain('key.preventDefault();');
            expect(disabledBlock).toContain('return;');
            expect(disabledBlock).toContain('onKeyDown(key);');
        });
    });

    describe('cursorColor', () => {
        it('keeps dim and bright cursor colors for disabled/enabled states', () => {
            const source = readTextareaSource();

            expect(source).toContain("const cursorColor = disabled ? '#333333' : '#ffffff';");
            expect(source).toContain('cursorColor={cursorColor}');
        });
    });

    describe('placeholder', () => {
        it('uses an exactOptionalPropertyTypes-safe conditional spread', () => {
            const source = readTextareaSource();

            expect(source).toContain('{...(placeholder !== undefined ? { placeholder } : {})}');
        });
    });

    describe('keyBindings override', () => {
        it('preserves default editing bindings before chat submit overrides', () => {
            expect(defaultTextareaKeyBindings.some((binding) => binding.name === 'backspace')).toBe(true);
            const source = readTextareaSource();

            expect(source).toContain('...defaultTextareaKeyBindings');
            expect(source).toContain("{ name: 'return', shift: true, action: 'newline' }");
            expect(source).toContain("{ name: 'return', action: 'submit' }");
            expect(source).toContain("{ name: 'kpenter', action: 'submit' }");
        });
    });
});
