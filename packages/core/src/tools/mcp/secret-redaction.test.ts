import { describe, expect, it } from 'vitest';
import { createSecretRedactor, MCP_REDACTED_SECRET } from './secret-redaction.js';

describe('createSecretRedactor', () => {
    it('redacts a known secret from a plain string', () => {
        const redactor = createSecretRedactor(['hunter2']);
        expect(redactor.redactText('password=hunter2')).toBe(`password=${MCP_REDACTED_SECRET}`);
    });

    it('redacts the secret nowhere when the value is absent', () => {
        const redactor = createSecretRedactor(['hunter2']);
        expect(redactor.redactText('nothing to see here')).toBe('nothing to see here');
    });

    it('replaces longest secret first so a shorter substring secret does not corrupt a longer one', () => {
        const redactor = createSecretRedactor(['hunter2', 'hunter2-super-secret']);
        expect(redactor.redactText('leak=hunter2-super-secret')).toBe(`leak=${MCP_REDACTED_SECRET}`);
    });

    it('deep-redacts strings inside nested objects and arrays', () => {
        const redactor = createSecretRedactor(['TOPSECRET']);
        const value = {
            ok: true,
            nested: { text: 'TOPSECRET in nested' },
            list: ['TOPSECRET in list', { inner: 'TOPSECRET inner' }],
            number: 42,
        };
        const redacted = redactor.redactValue(value);
        expect(JSON.stringify(redacted)).not.toContain('TOPSECRET');
        expect(JSON.stringify(redacted)).toContain(MCP_REDACTED_SECRET);
        expect(JSON.stringify(redacted)).toContain('42');
    });

    it('redacts error-shaped messages', () => {
        const redactor = createSecretRedactor(['sk-leaked-key']);
        const redacted = redactor.redactText('callTool "fail": server error: sk-leaked-key dropped');
        expect(redacted).not.toContain('sk-leaked-key');
        expect(redacted).toContain(MCP_REDACTED_SECRET);
    });

    it('ignores empty and duplicate secret entries', () => {
        const redactor = createSecretRedactor(['', 'dupe', 'dupe']);
        expect(redactor.redactText('value=dupe')).toBe(`value=${MCP_REDACTED_SECRET}`);
    });
});
