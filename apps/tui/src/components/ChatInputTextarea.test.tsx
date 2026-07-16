import { defaultTextareaKeyBindings } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { ChatInputTextarea, ChatInputTextareaBase } from './ChatInputTextarea';
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
        it('uses the OpenCode left-accent prompt frame (no right border)', () => {
            const source = readTextareaSource();

            expect(source).toContain("border={['left']}");
            expect(source).toContain('LEFT_ACCENT_BORDER');
            expect(source).toContain('CHAT_PRIMARY');
            expect(source).toContain('CHAT_ELEMENT_BG');
            expect(source).toContain('width="100%"');
            expect(source).toContain('flexShrink={0}');
            expect(source).toContain('minHeight={1}');
            expect(source).not.toContain("border={['left', 'right']}");
        });
    });

    describe('textarea handle contract', () => {
        it('reads content from props.textareaRef and falls back to an empty string', () => {
            const source = readTextareaSource();

            expect(source).toContain("const text = props.textareaRef.get()?.plainText ?? '';");
            expect(source).toContain('props.onContentChange(text);');
        });

        it('uses a Solid callback ref to update the production handle shape', () => {
            const source = readTextareaSource();

            expect(source).toContain(
                'ref={(renderable: TextareaRenderable) => props.textareaRef.set(renderable)}',
            );
            expect(source).not.toContain('.current');
        });
    });

    describe('disabled key guard', () => {
        it('prevents default and returns before forwarding when disabled', () => {
            const source = readTextareaSource();
            const disabledBlock = source.slice(
                source.indexOf('const handleKeyDown'),
                source.indexOf('return ('),
            );

            expect(disabledBlock).toContain('if (props.disabled)');
            expect(disabledBlock).toContain('key.preventDefault();');
            expect(disabledBlock).toContain('return;');
            expect(disabledBlock).toContain('props.onKeyDown(key);');
        });
    });

    describe('cursorColor', () => {
        it('keeps dim and bright cursor colors for disabled/enabled states', () => {
            const source = readTextareaSource();

            expect(source).toContain("cursorColor={props.disabled ? '#333333' : CHAT_TEXT}");
        });
    });

    describe('placeholder', () => {
        it('uses an exactOptionalPropertyTypes-safe conditional spread', () => {
            const source = readTextareaSource();

            expect(source).toContain(
                '{...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}',
            );
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

    describe('props reactivity', () => {
        it('does not destructure props (Solid one-shot freeze)', () => {
            const source = readTextareaSource();
            expect(source).toContain('export function ChatInputTextareaBase(props: ChatInputTextareaProps)');
            expect(source).not.toMatch(/export function ChatInputTextareaBase\(\{/);
        });
    });
});
