import { describe, expect, it } from 'vitest';
import {
    classifyFailure,
    isBudgetScopedRetryable,
    type FailureClassification,
} from './failure-taxonomy';

describe('classifyFailure', () => {
    it('maps TypeError fetch failed with isRetryable false to transient provider_timeout', () => {
        const classified = classifyFailure(
            Object.assign(new TypeError('fetch failed'), { isRetryable: false }),
        );
        expect(classified).toEqual({
            class: 'transient',
            code: 'provider_timeout',
            retryable: true,
            retryDisposition: 'after_delay',
        } satisfies FailureClassification);
    });

    it('maps 503 overload to transient provider_rate_limited', () => {
        const classified = classifyFailure({
            message: 'The service may be temporarily overloaded, please try again later',
            statusCode: 503,
            isRetryable: false,
        });
        expect(classified).toEqual({
            class: 'transient',
            code: 'provider_rate_limited',
            retryable: true,
            retryDisposition: 'after_delay',
        });
    });

    it('maps 401 to terminal provider_auth_failed', () => {
        const classified = classifyFailure({
            message: 'invalid api key',
            statusCode: 401,
            isRetryable: false,
        });
        expect(classified).toEqual({
            class: 'terminal',
            code: 'provider_auth_failed',
            retryable: false,
            retryDisposition: 'never',
        });
    });

    it('maps abort to terminal provider_aborted', () => {
        const classified = classifyFailure({
            code: 'provider_aborted',
            message: 'aborted by user',
            retryable: false,
        });
        expect(classified).toEqual({
            class: 'terminal',
            code: 'provider_aborted',
            retryable: false,
            retryDisposition: 'never',
        });
    });

    it('maps context overflow to terminal', () => {
        const classified = classifyFailure({
            code: 'provider_context_overflow',
            message: 'context length exceeded',
            retryable: false,
        });
        expect(classified).toEqual({
            class: 'terminal',
            code: 'provider_context_overflow',
            retryable: false,
            retryDisposition: 'never',
        });
    });

    it('emits canonical invalid_structured_output for structured admission failures', () => {
        const classified = classifyFailure({
            code: 'invalid_structured_output',
            message: 'output outside enum',
        });
        expect(classified).toEqual({
            class: 'rejected',
            code: 'invalid_structured_output',
            retryable: true,
            retryDisposition: 'after_change',
        });
    });

    it('accepts structured_output_invalid alias as input only and emits canonical code', () => {
        const classified = classifyFailure({
            code: 'structured_output_invalid',
            message: 'alias input',
        });
        expect(classified.code).toBe('invalid_structured_output');
        expect(classified.class).toBe('rejected');
        expect(classified.retryable).toBe(true);
        expect(classified.retryDisposition).toBe('after_change');
    });

    it('maps routing_dead_end to rejected with after_change disposition', () => {
        const classified = classifyFailure({
            code: 'routing_dead_end',
            message: 'no outbound edge matched',
        });
        expect(classified).toEqual({
            class: 'rejected',
            code: 'routing_dead_end',
            retryable: true,
            retryDisposition: 'after_change',
        });
    });

    it('maps tool_approval_blocked to denied', () => {
        const classified = classifyFailure({
            code: 'tool_approval_blocked',
            message: 'approval required',
        });
        expect(classified).toEqual({
            class: 'denied',
            code: 'tool_approval_blocked',
            retryable: false,
            retryDisposition: 'never',
        });
    });

    it('maps tool_settlement_failed to terminal', () => {
        const classified = classifyFailure({
            code: 'tool_settlement_failed',
            message: 'tool failed',
            retryable: false,
        });
        expect(classified).toEqual({
            class: 'terminal',
            code: 'tool_settlement_failed',
            retryable: false,
            retryDisposition: 'never',
        });
    });

    it('unwraps nested FlatProviderBridgeError overload as transient', () => {
        const classified = classifyFailure({
            error: {
                code: 'provider_rate_limited',
                message: 'overloaded',
                retryable: true,
            },
        });
        expect(classified.class).toBe('transient');
        expect(classified.code).toBe('provider_rate_limited');
        expect(classified.retryable).toBe(true);
    });

    it('unwraps AI SDK RetryError.lastError for overload classification', () => {
        const classified = classifyFailure({
            name: 'AI_RetryError',
            reason: 'maxRetriesExceeded',
            message: 'Failed after 3 attempts. Last error: temporarily overloaded',
            lastError: {
                message: 'The service may be temporarily overloaded, please try again later',
                statusCode: 503,
                isRetryable: false,
            },
        });
        expect(classified).toMatchObject({
            class: 'transient',
            code: 'provider_rate_limited',
            retryable: true,
        });
    });

    it('maps undici connect timeout as transient provider_timeout', () => {
        const classified = classifyFailure({
            message: 'Connect Timeout Error',
            code: 'UND_ERR_CONNECT_TIMEOUT',
            isRetryable: false,
        });
        expect(classified).toEqual({
            class: 'transient',
            code: 'provider_timeout',
            retryable: true,
            retryDisposition: 'after_delay',
        });
    });

    it('never emits dual public codes for structured alias', () => {
        const classified = classifyFailure({ code: 'structured_output_invalid' });
        expect(classified.code).toBe('invalid_structured_output');
        expect(classified.code).not.toBe('structured_output_invalid');
    });
});

describe('isBudgetScopedRetryable', () => {
    it('returns true for transient even when provider retryExhausted is true', () => {
        expect(
            isBudgetScopedRetryable({
                class: 'transient',
                code: 'provider_timeout',
                retryable: true,
                retryDisposition: 'after_delay',
            }),
        ).toBe(true);
    });

    it('returns true for rejected structured/routing failures under budget', () => {
        expect(
            isBudgetScopedRetryable({
                class: 'rejected',
                code: 'invalid_structured_output',
                retryable: true,
                retryDisposition: 'after_change',
            }),
        ).toBe(true);
    });

    it('returns false for terminal and denied classes', () => {
        expect(
            isBudgetScopedRetryable({
                class: 'terminal',
                code: 'provider_aborted',
                retryable: false,
                retryDisposition: 'never',
            }),
        ).toBe(false);
        expect(
            isBudgetScopedRetryable({
                class: 'denied',
                code: 'tool_approval_blocked',
                retryable: false,
                retryDisposition: 'never',
            }),
        ).toBe(false);
    });
});
