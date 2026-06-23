import { describe, expect, it } from 'vitest';
import { APPROVAL_LEVEL_META, APPROVAL_LEVELS, approvalLevelRules, isApprovalLevel } from './approval-level.js';

describe('approval-level', () => {
    it('exposes the canonical ordered level list', () => {
        expect(APPROVAL_LEVELS).toEqual(['verbose', 'safe', 'aggressive', 'reckless', 'yolo']);
    });

    it('auto-approves bash (command.run + bash.run) in aggressive mode', () => {
        const rules = approvalLevelRules('aggressive');
        const bashRule = rules.find((rule) => rule.permission === 'bash');
        expect(bashRule?.decision).toBe('always');
    });

    it('still asks before bash in verbose, safe, and reckless modes', () => {
        for (const level of ['verbose', 'safe', 'reckless'] as const) {
            const rules = approvalLevelRules(level);
            const bashRule = rules.find((rule) => rule.permission === 'bash');
            expect(bashRule?.decision).toBe('ask');
        }
    });

    it('keeps yolo auto-approving bash', () => {
        const rules = approvalLevelRules('yolo');
        const bashRule = rules.find((rule) => rule.permission === 'bash');
        expect(bashRule?.decision).toBe('always');
    });

    it('every level exposes a non-empty description and seven permission rules', () => {
        for (const level of APPROVAL_LEVELS) {
            const meta = APPROVAL_LEVEL_META[level];
            expect(meta.description.length).toBeGreaterThan(0);
            expect(meta.rules).toHaveLength(7);
        }
    });

    it('isApprovalLevel guards against unknown levels', () => {
        expect(isApprovalLevel('aggressive')).toBe(true);
        expect(isApprovalLevel('not-a-level')).toBe(false);
    });
});
