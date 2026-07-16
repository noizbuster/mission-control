import { describe, expect, it } from 'vitest';
import {
    buildCorrectionPayload,
    CORRECTION_PAYLOAD_FALLBACK,
    CORRECTION_PAYLOAD_MAX_CHARS,
} from './correction-payload';
import { REDACTED_CREDENTIAL } from '../providers/redaction-handler';

describe('buildCorrectionPayload', () => {
    it('returns non-empty fallback when input is empty', () => {
        // Given: no code, labels, or error
        // When
        const result = buildCorrectionPayload({});

        // Then: never empty (would skip correction on retry)
        expect(result.length).toBeGreaterThan(0);
        expect(result).toBe(CORRECTION_PAYLOAD_FALLBACK);
    });

    it('returns non-empty fallback when all fields are blank', () => {
        // Given
        const result = buildCorrectionPayload({
            code: '   ',
            allowedLabels: ['', '  '],
            errorMessage: '\n\t',
        });

        // Then
        expect(result.length).toBeGreaterThan(0);
        expect(result).toBe(CORRECTION_PAYLOAD_FALLBACK);
    });

    it('includes code, allowed labels, and short error for structured rejection', () => {
        // Given: invalid_structured_output re-queue inputs
        const result = buildCorrectionPayload({
            code: 'invalid_structured_output',
            allowedLabels: ['clear', 'unclear', 'on-the-fence'],
            errorMessage: 'output not in declared outputEnum',
        });

        // Then: structural tokens a machine/todo-5 consumer can rely on
        expect(result).toContain('code=invalid_structured_output');
        expect(result).toContain('allowed=clear|unclear|on-the-fence');
        expect(result).toContain('error=output not in declared outputEnum');
        expect(result.startsWith('CORRECTION')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(CORRECTION_PAYLOAD_MAX_CHARS);
    });

    it('notes boolean true|false when booleanShape is set without labels', () => {
        // Given: equals-routed boolean outputKey
        const result = buildCorrectionPayload({
            code: 'invalid_structured_output',
            booleanShape: true,
            errorMessage: 'expected boolean',
        });

        // Then
        expect(result).toContain('code=invalid_structured_output');
        expect(result).toContain('allowed=true|false');
        expect(result).toContain('error=expected boolean');
    });

    it('prefers explicit labels over booleanShape note', () => {
        // Given
        const result = buildCorrectionPayload({
            code: 'routing_dead_end',
            allowedLabels: ['retry', 'blocked'],
            booleanShape: true,
            errorMessage: 'no outbound edge matched',
        });

        // Then
        expect(result).toContain('allowed=retry|blocked');
        expect(result).not.toContain('allowed=true|false');
    });

    it('includes redacted observed value for routing dead-end re-admit', () => {
        // Given: observed poison blob with a token-like secret
        const result = buildCorrectionPayload({
            code: 'routing_dead_end',
            allowedLabels: ['clear', 'unclear'],
            errorMessage: 'no outbound edge matched',
            observedValue: { class: 'sk-live-secret-token-abcdef', note: 'blob' },
        });

        // Then
        expect(result).toContain('code=routing_dead_end');
        expect(result).toContain('allowed=clear|unclear');
        expect(result).toContain('observed=');
        expect(result).not.toContain('sk-live-secret-token-abcdef');
        expect(result).toContain(REDACTED_CREDENTIAL);
    });

    it('redacts known secrets from error and observed text', () => {
        // Given
        const secret = 'super-secret-api-key-xyz';
        const result = buildCorrectionPayload({
            code: 'invalid_structured_output',
            allowedLabels: ['a', 'b'],
            errorMessage: `failed near ${secret}`,
            observedValue: secret,
            secrets: [secret],
        });

        // Then
        expect(result).not.toContain(secret);
        expect(result).toContain(REDACTED_CREDENTIAL);
    });

    it('hard-caps output at CORRECTION_PAYLOAD_MAX_CHARS', () => {
        // Given: oversized error + many labels
        const longError = 'x'.repeat(800);
        const manyLabels = Array.from({ length: 40 }, (_, index) => `label-${index}-pad-pad`);

        // When
        const result = buildCorrectionPayload({
            code: 'invalid_structured_output',
            allowedLabels: manyLabels,
            errorMessage: longError,
            observedValue: 'y'.repeat(200),
        });

        // Then
        expect(result.length).toBeLessThanOrEqual(CORRECTION_PAYLOAD_MAX_CHARS);
        expect(result.length).toBe(CORRECTION_PAYLOAD_MAX_CHARS);
        expect(result.endsWith('…')).toBe(true);
        expect(result).toContain('code=invalid_structured_output');
    });

    it('serializes primitive observed values without throwing', () => {
        // Given / When / Then
        expect(buildCorrectionPayload({ code: 'routing_dead_end', observedValue: true })).toContain(
            'observed=true',
        );
        expect(buildCorrectionPayload({ code: 'routing_dead_end', observedValue: 42 })).toContain(
            'observed=42',
        );
        expect(buildCorrectionPayload({ code: 'routing_dead_end', observedValue: null })).toContain(
            'observed=null',
        );
    });

    it('omits observed when undefined and still includes code', () => {
        // Given
        const result = buildCorrectionPayload({
            code: 'invalid_structured_output',
            allowedLabels: ['yes', 'no'],
        });

        // Then
        expect(result).toContain('code=invalid_structured_output');
        expect(result).toContain('allowed=yes|no');
        expect(result).not.toContain('observed=');
    });
});
