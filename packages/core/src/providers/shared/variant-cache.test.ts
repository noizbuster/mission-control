import type { ModelCatalogEntry, ModelProviderCatalogEntry } from '@mission-control/config';
import { describe, expect, it, vi } from 'vitest';
import { createVariantLookup } from './variant-cache.js';

describe('createVariantLookup', () => {
    it('reports configured variants and rejects unknown ones', () => {
        const catalog = catalogWith({
            openai: { 'gpt-5.5': ['reasoning-high', 'reasoning-low'], 'gpt-4o-mini': [] },
        });
        const lookup = createVariantLookup(catalog);

        expect(lookup('openai', 'gpt-5.5', 'reasoning-high')).toBe(true);
        expect(lookup('openai', 'gpt-5.5', 'reasoning-low')).toBe(true);
        expect(lookup('openai', 'gpt-5.5', 'reasoning-medium')).toBe(false);
        expect(lookup('openai', 'gpt-4o-mini', 'reasoning-high')).toBe(false);
        expect(lookup('unknown-provider', 'gpt-5.5', 'reasoning-high')).toBe(false);
    });

    it('scans the catalog once per provider then memoizes (spy assertion)', () => {
        const catalog = catalogWith({ openai: { 'gpt-5.5': ['reasoning-high', 'reasoning-low'] } });
        const lookup = createVariantLookup(catalog);
        const findSpy = vi.spyOn(catalog, 'find');

        lookup('openai', 'gpt-5.5', 'reasoning-high');
        lookup('openai', 'gpt-5.5', 'reasoning-low');
        lookup('openai', 'gpt-5.5', 'reasoning-high');
        lookup('openai', 'gpt-5.5', 'reasoning-medium');

        expect(findSpy).toHaveBeenCalledTimes(1);
        findSpy.mockClear();

        lookup('openai', 'gpt-5.5', 'reasoning-high');
        expect(findSpy).not.toHaveBeenCalled();
    });

    it('scans once per distinct provider', () => {
        const catalog = catalogWith({
            openai: { 'gpt-5.5': ['reasoning-high'] },
            anthropic: { 'claude-x': ['thinking-high'] },
        });
        const lookup = createVariantLookup(catalog);
        const findSpy = vi.spyOn(catalog, 'find');

        lookup('openai', 'gpt-5.5', 'reasoning-high');
        lookup('openai', 'gpt-5.5', 'reasoning-high');
        lookup('anthropic', 'claude-x', 'thinking-high');
        lookup('anthropic', 'claude-x', 'thinking-high');

        expect(findSpy).toHaveBeenCalledTimes(2);
    });

    it('does not scan the catalog until the first lookup (lazy build)', () => {
        const catalog = catalogWith({ openai: { 'gpt-5.5': ['reasoning-high'] } });
        const findSpy = vi.spyOn(catalog, 'find');

        expect(findSpy).not.toHaveBeenCalled();
        createVariantLookup(catalog);
        expect(findSpy).not.toHaveBeenCalled();
    });
});

function catalogWith(
    providers: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
): ModelProviderCatalogEntry[] {
    return Object.entries(providers).map(([providerID, models]) => providerEntry(providerID, models));
}

function providerEntry(
    providerID: string,
    models: Readonly<Record<string, readonly string[]>>,
): ModelProviderCatalogEntry {
    const modelEntries = Object.entries(models).map(([modelID, variants]) => modelEntry(modelID, variants));
    return {
        id: providerID,
        name: providerID,
        defaultModelID: modelEntries[0]?.id ?? 'default',
        authLabel: providerID,
        authFields: [],
        authMethods: [],
        capability: { status: 'model-discovery-only' },
        models: modelEntries,
    };
}

function modelEntry(modelID: string, variants: readonly string[]): ModelCatalogEntry {
    return {
        id: modelID,
        name: modelID,
        status: 'active',
        ...(variants.length > 0
            ? { variants: variants.map((id) => ({ id, name: id, status: 'active' as const })) }
            : {}),
    };
}
