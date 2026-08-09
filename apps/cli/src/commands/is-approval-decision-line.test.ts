import { describe, expect, it } from 'vitest';
import { isApprovalDecisionLine } from './interactive-approval-helpers';

describe('isApprovalDecisionLine', () => {
    it('accepts approval vocab including short deny/allow aliases', () => {
        for (const line of [
            'once',
            'o',
            'session',
            's',
            'always',
            'a',
            'deny',
            'n',
            'no',
            'DENY',
            'y',
            'yes',
            'allow',
        ]) {
            expect(isApprovalDecisionLine(line)).toBe(true);
        }
        expect(isApprovalDecisionLine('please fix the bug')).toBe(false);
        expect(isApprovalDecisionLine('/compact')).toBe(false);
    });
});
