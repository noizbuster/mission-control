import { describe, expect, it } from 'vitest';
import { buildModelContextPrefLines } from './model-context-pref-lines';

describe('buildModelContextPrefLines', () => {
    it('renders context and compact slider lines for a focused model', () => {
        // Given
        const selection = { providerID: 'openai', modelID: 'gpt-5' };
        const prefs = [{ modelKey: 'openai/gpt-5', contextLimit: 128_000, autoCompactThreshold: 0.8 }];

        // When
        const lines = buildModelContextPrefLines(selection, prefs);

        // Then
        expect(lines.effectiveContextLimit).toBe(128_000);
        expect(lines.autoCompactThreshold).toBe(0.8);
        expect(lines.contextLine).toContain('128k');
        expect(lines.compactLine).toContain('80%');
        expect(lines.contextLine).toContain('(-/=)');
        expect(lines.compactLine).toContain('([/])');
    });

    it('shows compact off when no threshold is stored', () => {
        // Given / When
        const lines = buildModelContextPrefLines({ providerID: 'local', modelID: 'local-echo' }, []);

        // Then
        expect(lines.autoCompactThreshold).toBe(0);
        expect(lines.compactLine).toContain('off');
    });
});
