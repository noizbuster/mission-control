import type { ModelPattern } from '@mission-control/core';
import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    cleanGeneratedSessionTitle,
    createSessionTitleTurnInput,
    normalizeSessionPromptTitle,
    selectSessionTitleModel,
} from './interactive-chat-session-title';

declare global {
    interface String {
        isWellFormed(): boolean;
    }
}

const activeSelection: ModelProviderSelection = { providerID: 'active', modelID: 'large' };

describe('interactive session prompt titles', () => {
    it('normalizes whitespace in the first prompt', () => {
        // Given: a first prompt containing leading, repeated, and line-break whitespace.
        const prompt = '  Investigate\n\t parser   title  ';

        // When: the prompt is converted to its immediate session title.
        const title = normalizeSessionPromptTitle(prompt);

        // Then: all whitespace is collapsed into single spaces.
        expect(title).toBe('Investigate parser title');
    });

    it('caps a long prompt title at 100 characters with an ellipsis', () => {
        // Given: a normalized first prompt longer than the title limit.
        const prompt = 'a'.repeat(101);

        // When: the prompt title is normalized.
        const title = normalizeSessionPromptTitle(prompt);

        // Then: the title uses 97 prompt characters followed by three dots.
        expect(title).toBe(`${'a'.repeat(97)}...`);
        expect(title).toHaveLength(100);
    });

    it('truncates emoji prompt titles only at grapheme boundaries', () => {
        // Given: a prompt longer than the limit in multi-code-point family emoji graphemes.
        const family = '👨‍👩‍👧‍👦';
        const prompt = family.repeat(101);

        // When: the prompt becomes a bounded title.
        const title = normalizeSessionPromptTitle(prompt);

        // Then: 97 complete emoji remain before the ellipsis and the string is well formed.
        expect(title).toBe(`${family.repeat(97)}...`);
        expect(title.isWellFormed()).toBe(true);
    });

    it('removes terminal control and bidi characters from prompt titles', () => {
        // Given: prompt text containing OSC introducers, BEL, DEL, C1, and bidi controls.
        const prompt = ' safe\tname\u0007\u001b]2;owned\u007f\u0085\u202Etext\u2066한국어\u2069\u061C ';

        // When: the prompt is normalized for display and persistence.
        const title = normalizeSessionPromptTitle(prompt);

        // Then: unsafe controls are absent while ordinary whitespace and Korean text remain.
        expect(title).toBe('safe name]2;owned text한국어');
        expect(title).not.toContain('\u001b');
        expect(title).not.toContain('\u0007');
        expect(title).not.toContain('\u202E');
        expect(title).not.toContain('\u061C');
    });
});

describe('interactive session title provider request', () => {
    it('builds a unique no-tools turn containing only the first prompt', () => {
        // Given: a newly materialized session and its first plain prompt.
        const prompt = 'Fix the parser race';

        // When: two title turn inputs are created for the same session.
        const first = createSessionTitleTurnInput('session_title_test', prompt, activeSelection);
        const second = createSessionTitleTurnInput('session_title_test', prompt, activeSelection);

        // Then: each request is unique, starts at zero, and exposes no tools or conversation history.
        expect(first.turnId).not.toBe(first.requestId);
        expect(first.turnId).not.toBe(second.turnId);
        expect(first.requestId).not.toBe(second.requestId);
        expect(first.startSequence).toBe(0);
        expect(first).not.toHaveProperty('tools');
        expect(first.messages).toHaveLength(2);
        const systemMessage = first.messages[0];
        if (systemMessage?.role !== 'system') {
            throw new Error('expected the first title request message to be a system message');
        }
        expect(systemMessage.content).toContain('same language');
        expect(systemMessage.content).toContain('intent or topic');
        expect(systemMessage.content).toContain('50 characters');
        expect(first.messages[1]).toEqual({ role: 'user', content: prompt });
    });

    it('strips reasoning, takes the first title line, and hard-caps provider output', () => {
        // Given: provider output with reasoning, blank lines, multiple title lines, and excess length.
        const output = `<think>private reasoning\nwith details</think>\n\n${'T'.repeat(110)}\nignored explanation`;

        // When: the provider output is cleaned for display and persistence.
        const title = cleanGeneratedSessionTitle(output);

        // Then: only the first non-empty post-reasoning line remains, capped with an ellipsis.
        expect(title).toBe(`${'T'.repeat(97)}...`);
    });

    it('truncates generated titles without splitting combining graphemes', () => {
        // Given: generated output longer than the limit in decomposed accented graphemes.
        const accented = 'é';
        const output = accented.repeat(101);

        // When: generated output is cleaned.
        const title = cleanGeneratedSessionTitle(output);

        // Then: every combining mark stays attached and the result is well formed.
        expect(title).toBe(`${accented.repeat(97)}...`);
        expect(title.isWellFormed()).toBe(true);
    });

    it('removes terminal control and bidi characters from generated titles', () => {
        // Given: generated title output containing bidi overrides, BEL, RLM, and normal emoji.
        const output = '\u061C\u202EGenerated\u0007 title\u200F 👩‍💻';

        // When: provider output is cleaned.
        const title = cleanGeneratedSessionTitle(output);

        // Then: controls are removed without damaging ordinary text or emoji.
        expect(title).toBe('Generated title 👩‍💻');
        expect(title).not.toContain('\u0007');
        expect(title).not.toContain('\u200F');
        expect(title).not.toContain('\u061C');
    });

    it('treats reasoning-only provider output as an empty no-op', () => {
        // Given: a provider response containing no title outside its reasoning block.
        const output = '<think>private reasoning only</think>\n  ';

        // When: the output is cleaned.
        const title = cleanGeneratedSessionTitle(output);

        // Then: no generated title is returned.
        expect(title).toBe('');
    });
});

describe('interactive session title role selection', () => {
    const titleSelection: ModelPattern = { providerID: 'roles', modelID: 'title-model' };
    const smolSelection: ModelPattern = { providerID: 'roles', modelID: 'smol-model' };

    it('prefers the persisted title role over every fallback', () => {
        // Given: persisted title and smol role assignments plus an active model.
        const roleConfig = { title: titleSelection, smol: smolSelection };

        // When: the title model is selected.
        const selected = selectSessionTitleModel(roleConfig, activeSelection);

        // Then: the dedicated title role wins.
        expect(selected).toEqual(titleSelection);
    });

    it('falls back from the title role to the persisted smol role', () => {
        // Given: only a persisted smol role assignment.
        const roleConfig = { smol: smolSelection };

        // When: the title model is selected.
        const selected = selectSessionTitleModel(roleConfig, activeSelection);

        // Then: the small role is selected.
        expect(selected).toEqual(smolSelection);
    });

    it('falls back from both persisted roles to the active session model', () => {
        // Given: no persisted role assignments.
        const roleConfig: Partial<Record<ModelRole, ModelPattern>> = {};

        // When: the title model is selected.
        const selected = selectSessionTitleModel(roleConfig, activeSelection);

        // Then: the active session selection is reused.
        expect(selected).toEqual(activeSelection);
    });

    it('strips the active variant only for the active-model fallback', () => {
        // Given: no role assignment and an active model carrying a reasoning variant.
        const activeWithVariant: ModelProviderSelection = {
            providerID: 'active',
            modelID: 'large',
            variantID: 'reasoning-high',
        };

        // When: role selection falls back to the active model.
        const selected = selectSessionTitleModel({}, activeWithVariant);

        // Then: the title request uses the provider/model without the active reasoning variant.
        expect(selected).toEqual({ providerID: 'active', modelID: 'large' });
    });

    it('preserves a variant explicitly configured for the title role', () => {
        // Given: an explicit title-role model variant.
        const configured: ModelPattern = {
            providerID: 'roles',
            modelID: 'title-model',
            variantID: 'thinking-low',
        };

        // When: the title role is selected.
        const selected = selectSessionTitleModel({ title: configured }, activeSelection);

        // Then: its explicit variant remains intact.
        expect(selected).toEqual(configured);
    });
});
