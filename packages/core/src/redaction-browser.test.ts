import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from './redaction';
import { readFile } from 'node:fs/promises';

describe('browser redaction export', () => {
    it('keeps the public redaction dependency graph free of Node-only runtime APIs', async () => {
        // Given
        const sourcePath = new URL('./providers/observability-value-redactor.ts', import.meta.url);
        const secret = ['known', 'browser', 'credential'].join('_');

        // When
        const source = await readFile(sourcePath, 'utf8');
        const observable = JSON.stringify(
            createObservabilityRedactor({ secrets: [secret] }).redactValue({ nested: secret }),
        );

        // Then
        expect(source).not.toMatch(/\bBuffer\b/);
        expect(source).not.toMatch(/from ['"]node:/);
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(secret);
    });
});
