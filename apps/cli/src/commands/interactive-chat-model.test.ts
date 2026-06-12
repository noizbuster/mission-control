import { describe, expect, it } from 'vitest';
import {
    createModelChoices,
    createVariantChoices,
    formatModelSelection,
    resolveModelCommand,
} from './interactive-chat-model.js';

const currentSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} as const;

describe('interactive chat model command', () => {
    it('resolves direct provider/model selections', () => {
        expect(resolveModelCommand('local/local-echo#fast', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'fast',
            },
        });
        expect(resolveModelCommand('local local-echo thinking', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'thinking',
            },
        });
        expect(resolveModelCommand('anthropic/claude-3-5-haiku-20241022', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'anthropic',
                modelID: 'claude-3-5-haiku-20241022',
            },
        });
        expect(resolveModelCommand('anthropic/claude-sonnet-4-6#thinking-high', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'anthropic',
                modelID: 'claude-sonnet-4-6',
                variantID: 'thinking-high',
            },
        });
        expect(resolveModelCommand('anthropic claude-3-5-haiku-20241022', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'anthropic',
                modelID: 'claude-3-5-haiku-20241022',
            },
        });
    });

    it('parses provider slash model ids at the first slash', () => {
        expect(resolveModelCommand('openrouter/anthropic/claude-3-haiku', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'openrouter',
                modelID: 'anthropic/claude-3-haiku',
            },
        });
    });

    it('returns list and picker resolutions without exposing credentials', () => {
        const list = resolveModelCommand('list', currentSelection);
        const picker = resolveModelCommand('pick', currentSelection);

        expect(list.type).toBe('list');
        expect(picker).toEqual({ type: 'pick' });
        if (list.type !== 'list') {
            throw new Error('expected list result');
        }
        expect(list.totalCount).toBeGreaterThan(20);
        expect(list.visibleChoices).toHaveLength(20);
        expect(list.visibleChoices[0]?.label).toBe('local/local-echo [executable]');
        expect(JSON.stringify(list)).not.toContain('apiKey');
    });

    it('reports invalid model selections without changing the current model', () => {
        expect(resolveModelCommand('missing/provider', currentSelection)).toEqual({
            type: 'invalid',
            message: 'Unknown model: missing/provider',
            currentSelection,
        });
        expect(resolveModelCommand('local/local-echo#missing', currentSelection)).toEqual({
            type: 'invalid',
            message: 'Variant missing is not available for model local/local-echo',
            currentSelection,
        });
        expect(resolveModelCommand('openai/gpt-4o-mini#missing', currentSelection)).toEqual({
            type: 'invalid',
            message: 'Variant missing is not available for model openai/gpt-4o-mini',
            currentSelection,
        });
        expect(
            resolveModelCommand('perplexity/sonar', currentSelection, {
                choices: createModelChoices({ providerIDs: ['perplexity'] }),
            }),
        ).toEqual({
            type: 'invalid',
            message: 'Provider perplexity is model-discovery-only and cannot run coding agent prompts',
            currentSelection,
        });
    });

    it('formats model selections', () => {
        const choices = createModelChoices();

        expect(formatModelSelection(currentSelection)).toBe('local/local-echo');
        expect(formatModelSelection({ ...currentSelection, variantID: 'fast' })).toBe('local/local-echo#fast');
        expect(choices[0]).toMatchObject({
            id: 'local/local-echo',
            label: 'local/local-echo [executable]',
            selection: currentSelection,
            availableForCoding: true,
        });
    });

    it('formats variant choices separately from model choices', () => {
        const variants = createVariantChoices(currentSelection);

        expect(variants[0]).toMatchObject({
            id: 'local/local-echo#default',
            label: 'local/local-echo#default [executable]',
            selection: { ...currentSelection, variantID: 'default' },
        });
    });

    it('labels discovery-only choices as unavailable for coding', () => {
        const choices = createModelChoices({ providerIDs: ['perplexity'] });

        expect(choices[0]).toMatchObject({
            id: 'perplexity/sonar',
            label: 'perplexity/sonar [model-discovery-only: cannot run coding agent prompts]',
            availableForCoding: false,
            unavailableReason: 'Provider perplexity is model-discovery-only and cannot run coding agent prompts',
        });
    });
});
