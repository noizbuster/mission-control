import { describe, expect, it } from 'vitest';
import {
    contextOverflowRecoveryNotice,
    contextPressureStatus,
    isContextOverflowMessage,
} from './context-pressure';

describe('contextPressureStatus', () => {
    it('is ok when max is unknown or fill is low', () => {
        expect(contextPressureStatus(100, undefined).level).toBe('ok');
        expect(contextPressureStatus(10, 100).level).toBe('ok');
        expect(contextPressureStatus(10, 100).notice).toBeUndefined();
    });

    it('warns and escalates by fill ratio', () => {
        expect(contextPressureStatus(75, 100)).toMatchObject({
            level: 'warn',
            percent: 75,
        });
        expect(contextPressureStatus(75, 100).notice).toContain('/compact');
        expect(contextPressureStatus(95, 100)).toMatchObject({
            level: 'critical',
            percent: 95,
        });
        expect(contextPressureStatus(95, 100).notice).toContain('nearly full');
    });
});

describe('isContextOverflowMessage', () => {
    it('detects common provider overflow phrasings', () => {
        expect(isContextOverflowMessage('Error: context length exceeded')).toBe(true);
        expect(isContextOverflowMessage('provider_context_overflow')).toBe(true);
        expect(isContextOverflowMessage('request_too_large')).toBe(true);
        expect(isContextOverflowMessage('network timeout')).toBe(false);
    });
});

describe('contextOverflowRecoveryNotice', () => {
    it('points the operator at /compact', () => {
        const notice = contextOverflowRecoveryNotice('Error: context window exceeded');
        expect(notice).toContain('/compact');
        expect(notice).toContain('context window exceeded');
    });
});
