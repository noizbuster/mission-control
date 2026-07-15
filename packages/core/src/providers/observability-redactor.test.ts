import type { AgentEvent, ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { redactProviderChunkForObservability } from './observability-provider-chunk';
import {
    createObservabilityRedactor,
    OBSERVABILITY_CIRCULAR,
    OBSERVABILITY_TRUNCATED,
    OBSERVABILITY_UNAVAILABLE,
    redactAgentEventForObservability,
} from './observability-redactor';
import { REDACTED_CREDENTIAL } from './redaction-handler';

describe('observability redactor', () => {
    it('deep-redacts strings, arrays, plain objects, and errors without mutating input', () => {
        // Given
        const knownCredential = ['known', 'recursive', 'credential'].join('_');
        const patternCredential = ['sk', 'recursive', 'secret123'].join('-');
        const error = new Error(`failure ${patternCredential}`, {
            cause: { headers: { Authorization: `Bearer ${knownCredential}` } },
        });
        const input = {
            ordinary: 'keep-this-value',
            nested: [{ command: ['tool', '--token', knownCredential] }, error],
        };
        const before = JSON.stringify(input);
        const redactor = createObservabilityRedactor({ secrets: [knownCredential] });

        // When
        const redacted = redactor.redactValue(input);
        const observable = JSON.stringify(redacted);

        // Then
        expect(JSON.stringify(input)).toBe(before);
        expect(observable.includes(REDACTED_CREDENTIAL)).toBe(true);
        expect(observable.includes('keep-this-value')).toBe(true);
        expect(observable.includes(knownCredential)).toBe(false);
        expect(observable.includes(patternCredential)).toBe(false);
    });

    it('bounds depth, entry count, and UTF-8 output while failing cyclic values safely', () => {
        // Given
        const cyclic: { ordinary: string; self?: unknown; large?: string } = { ordinary: 'keep-this-value' };
        cyclic.self = cyclic;
        cyclic.large = String.fromCharCode(0).repeat(4_096);
        const redactor = createObservabilityRedactor({ maxBytes: 128, maxDepth: 3, maxEntries: 8 });

        // When
        const redacted = redactor.redactValue(cyclic);
        const observable = JSON.stringify(redacted);

        // Then
        expect(observable.includes(OBSERVABILITY_CIRCULAR)).toBe(true);
        expect(observable.includes(OBSERVABILITY_TRUNCATED)).toBe(true);
        expect(new TextEncoder().encode(observable).byteLength).toBeLessThanOrEqual(128);
    });

    it('preserves ordinary tool call identifiers but redacts configured credentials used as identifiers', () => {
        // Given
        const identifier = ['sk', 'tool', 'identifier123'].join('-');
        const configuredIdentifier = ['configured', 'tool', 'identifier'].join('_');
        const valueSecret = ['sk', 'tool', 'value123'].join('-');
        const redactor = createObservabilityRedactor({ secrets: [configuredIdentifier] });

        // When
        const redacted = redactor.redactValue({
            ordinary: { toolCallId: identifier },
            configured: { toolCallId: configuredIdentifier },
            output: valueSecret,
        });
        const observable = JSON.stringify(redacted);

        // Then
        expect(observable.includes(identifier)).toBe(true);
        expect(observable.includes(configuredIdentifier)).toBe(false);
        expect(observable.includes(valueSecret)).toBe(false);
        expect(observable.includes(REDACTED_CREDENTIAL)).toBe(true);
    });

    it('redacts secret-bearing object keys without dropping deterministic collisions', () => {
        // Given
        const knownCredential = ['known', 'object', 'key'].join('_');
        const input = {
            [knownCredential]: 'first-value',
            [REDACTED_CREDENTIAL]: 'second-value',
        };
        const redactor = createObservabilityRedactor({ secrets: [knownCredential] });

        // When
        const once = redactor.redactValue(input);
        const twice = redactor.redactValue(once);
        const observable = JSON.stringify(once);

        // Then
        expect(observable.includes(knownCredential)).toBe(false);
        expect(observable.includes('first-value')).toBe(true);
        expect(observable.includes('second-value')).toBe(true);
        expect(Object.keys(once ?? {})).toHaveLength(2);
        expect(twice).toEqual(once);
    });

    it('does not invoke accessors or throw on hostile observable values', () => {
        // Given
        let getterCalls = 0;
        const input = Object.defineProperty({ ordinary: 'keep-this-value' }, 'hostile', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                throw new Error('raw accessor secret');
            },
        });
        const redactor = createObservabilityRedactor();

        // When
        const redact = () => redactor.redactValue(input);

        // Then
        expect(redact).not.toThrow();
        expect(getterCalls).toBe(0);
        expect(JSON.stringify(redact())).not.toContain('raw accessor secret');
    });

    it('fails closed without throwing for a revoked proxy', () => {
        // Given
        const revocable = Proxy.revocable({ secret: 'unreachable' }, {});
        revocable.revoke();
        const redactor = createObservabilityRedactor();

        // When
        const redact = () => redactor.redactValue(revocable.proxy);

        // Then
        expect(redact).not.toThrow();
        expect(redact()).toBe(OBSERVABILITY_UNAVAILABLE);
    });

    it('replaces hostile provider-chunk accessor failures with a credential-free boundary error', () => {
        const credential = ['hostile', 'provider', 'credential'].join('_');
        const chunk: ProviderStreamChunk = Object.defineProperty(
            {
                kind: 'response_started',
                requestId: 'request_hostile_chunk',
                sequence: 0,
            },
            'hostile',
            {
                enumerable: true,
                get: () => {
                    throw new Error(`getter exposed ${credential}`);
                },
            },
        );
        const redactor = createObservabilityRedactor({ secrets: [credential] });

        expect(() => redactProviderChunkForObservability(chunk, redactor)).toThrow(
            'Provider stream chunk could not be redacted',
        );
        expect(() => redactProviderChunkForObservability(chunk, redactor)).not.toThrow(credential);
    });

    it('redacts completed reasoning and every permission or approval text copy', () => {
        // Given
        const knownCredential = ['arbitrary', 'approval', 'credential'].join('_');
        const event: AgentEvent = {
            type: 'approval.requested',
            timestamp: '2026-07-13T00:00:00.000Z',
            message: `request ${knownCredential}`,
            permissionRequest: {
                id: 'permission_ordinary',
                action: 'command.run',
                reason: `run ${knownCredential}`,
                permission: {
                    kind: 'bash',
                    patterns: [`node --token ${knownCredential}`],
                    workspaceRoot: `/workspace/${knownCredential}`,
                },
            },
            permissionDecision: {
                requestId: 'permission_ordinary',
                status: 'requires_approval',
                reason: `matched ${knownCredential}`,
            },
            permissionReply: {
                approvalId: 'approval_ordinary',
                reply: 'deny',
                reason: `denied ${knownCredential}`,
            },
            approvalRecord: {
                approvalId: 'approval_ordinary',
                requestId: 'permission_ordinary',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'command.run' },
                requestedAt: '2026-07-13T00:00:00.000Z',
                reason: `approval ${knownCredential}`,
            },
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'request_ordinary',
                sequence: 1,
                message: {
                    messageId: 'message_ordinary',
                    role: 'assistant',
                    content: 'keep-this-content',
                    reasoning: `reasoning ${knownCredential}`,
                },
                finishReason: 'stop',
            },
        };
        const redactor = createObservabilityRedactor({ secrets: [knownCredential] });

        // When
        const redacted = redactAgentEventForObservability(event, redactor);
        const observable = JSON.stringify(redacted);

        // Then
        expect(observable.includes(knownCredential)).toBe(false);
        expect(observable.includes(REDACTED_CREDENTIAL)).toBe(true);
        expect(observable.includes('permission_ordinary')).toBe(true);
        expect(observable.includes('keep-this-content')).toBe(true);
    });

    it('redacts configured credentials from every structured event metadata branch', () => {
        // Given
        const credential = ['configured', 'event', 'metadata'].join('_');
        const event: AgentEvent = {
            type: 'task.progress',
            timestamp: '2026-07-13T00:00:00.000Z',
            modelProviderSelection: {
                providerID: `provider-${credential}`,
                modelID: `model-${credential}`,
            },
            run: {
                state: 'running',
                runId: `run-${credential}`,
                requestId: `request-${credential}`,
                reason: `reason ${credential}`,
            },
            sessionTree: {
                kind: 'metadata',
                name: `name ${credential}`,
                cwd: `/workspace/${credential}`,
                trustedRoot: `/trusted/${credential}`,
            },
            transcript: {
                inputId: `input-${credential}`,
                providerTurnId: `turn-${credential}`,
                reason: `transcript ${credential}`,
            },
            abg: {
                graphId: `graph-${credential}`,
                causationId: `cause-${credential}`,
                correlationId: `correlation-${credential}`,
                model: {
                    providerID: `provider-${credential}`,
                    modelID: `model-${credential}`,
                    role: `role-${credential}`,
                    fallbacks: [{ providerID: `fallback-${credential}`, modelID: 'ordinary-model' }],
                },
            },
        };
        const redactor = createObservabilityRedactor({ secrets: [credential] });

        // When
        const observable = JSON.stringify(redactAgentEventForObservability(event, redactor));

        // Then
        expect(observable).toContain(REDACTED_CREDENTIAL);
        expect(observable).not.toContain(credential);
    });

    it('keeps arrays containing undefined within the exact UTF-8 byte limit', () => {
        // Given
        const maxBytes = 32;
        const redactor = createObservabilityRedactor({ maxBytes });

        // When
        const observable = JSON.stringify(redactor.redactValue(Array.from({ length: 20 }, () => undefined)));

        // Then
        expect(new TextEncoder().encode(observable).byteLength).toBeLessThanOrEqual(maxBytes);
    });
});
