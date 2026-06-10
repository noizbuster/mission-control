import { describe, expect, it } from 'vitest';
import { createModelChoices, formatModelSelection, resolveModelCommand } from './interactive-chat-model.js';

const currentSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} as const;

describe('interactive chat model command', () => {
    it('resolves direct provider/model selections', () => {
        expect(resolveModelCommand('anthropic/claude-3-5-haiku-20241022', currentSelection)).toEqual({
            type: 'select',
            selection: {
                providerID: 'anthropic',
                modelID: 'claude-3-5-haiku-20241022',
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
        expect(
            resolveModelCommand(
                'cloudflare-ai-gateway/workers-ai/@cf/ai4bharat/indictrans2-en-indic-1B',
                currentSelection,
            ),
        ).toEqual({
            type: 'select',
            selection: {
                providerID: 'cloudflare-ai-gateway',
                modelID: 'workers-ai/@cf/ai4bharat/indictrans2-en-indic-1B',
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
        expect(list.visibleChoices[0]?.label).toBe('local/local-echo');
        expect(JSON.stringify(list)).not.toContain('apiKey');
    });

    it('reports invalid model selections without changing the current model', () => {
        expect(resolveModelCommand('missing/provider', currentSelection)).toEqual({
            type: 'invalid',
            message: 'Unknown model: missing/provider',
            currentSelection,
        });
    });

    it('formats model selections', () => {
        const choices = createModelChoices();

        expect(formatModelSelection(currentSelection)).toBe('local/local-echo');
        expect(choices[0]).toMatchObject({
            id: 'local/local-echo',
            label: 'local/local-echo',
            selection: currentSelection,
        });
    });
});
