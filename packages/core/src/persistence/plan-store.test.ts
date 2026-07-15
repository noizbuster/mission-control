import { describe, expect, it } from 'vitest';
import { type PlanChecklist, parsePlanChecklistText, parsePlanSections } from './plan-store';

describe('parsePlanChecklistText — section-scoped counting', () => {
    it('counts all column-0 checkboxes when no counted heading exists (fallback)', () => {
        const markdown = ['- [x] done task', '- [ ] open task', '- [X] also done'].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(3);
        expect(result.completed).toBe(2);
        expect(result.unchecked).toBe(1);
    });

    it('counts only checkboxes under ## TODOs and ## Final Verification Wave', () => {
        const markdown = [
            '# Plan',
            '',
            '- [x] intro checkbox (no heading — should not count)',
            '',
            '## TODOs',
            '',
            '- [x] real task one',
            '- [ ] real task two',
            '',
            '## Notes',
            '',
            '- [x] note checkbox (wrong section — should not count)',
            '',
            '## Final Verification Wave',
            '',
            '- [x] verified',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(3);
        expect(result.completed).toBe(2);
        expect(result.unchecked).toBe(1);
    });

    it('ignores nested/indented checkboxes even inside counted sections', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] top-level task',
            '  - [ ] nested acceptance criterion (should not count)',
            '    - [x] deeply nested evidence (should not count)',
            '- [x] another top-level task',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(2);
        expect(result.items.map((item) => item.text)).toEqual(['top-level task', 'another top-level task']);
    });

    it('ignores checkboxes under Notes, Acceptance Criteria, Evidence, Definition of Done', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] 1. implement parser',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] parser handles edge cases (should not count)',
            '',
            '## Evidence',
            '',
            '- [x] test output attached (should not count)',
            '',
            '## Definition of Done',
            '',
            '- [x] all tests pass (should not count)',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. goal verification',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(2);
        expect(result.items.map((item) => item.text)).toEqual(['1. implement parser', 'F1. goal verification']);
    });

    it('surfaces nextTaskLabel as the first unchecked todo label', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [x] 1. first task done',
            '- [ ] 2. second task open',
            '- [ ] 3. third task open',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. final check',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.nextTaskLabel).toBe('2. second task open');
    });

    it('returns null nextTaskLabel when all counted checkboxes are checked', () => {
        const markdown = ['## TODOs', '', '- [x] 1. done', '', '## Final Verification Wave', '', '- [x] F1. done'].join(
            '\n',
        );

        const result = parsePlanChecklistText(markdown);

        expect(result.nextTaskLabel).toBeNull();
    });

    it('returns null nextTaskLabel when there are no counted checkboxes', () => {
        const markdown = ['## Notes', '', '- [x] nothing actionable here'].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(0);
        expect(result.nextTaskLabel).toBeNull();
    });

    it('treats ## Todos (lowercase s) as a counted heading', () => {
        const markdown = [
            '## Todos',
            '',
            '- [ ] 1. task A',
            '- [x] 2. task B',
            '',
            '## Scope',
            '',
            '- [x] not counted',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(2);
        expect(result.items.map((item) => item.text)).toEqual(['1. task A', '2. task B']);
    });

    it('counts top-level 1. and F1. labeled items under the counted headings', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] 1. Port atlas parser',
            '- [ ] 2. Wire notepad store',
            '- [x] 3. Add delegation template',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. Goal verification',
            '- [ ] F2. Constraint verification',
        ].join('\n');

        const result = parsePlanChecklistText(markdown);

        expect(result.total).toBe(5);
        expect(result.completed).toBe(1);
        expect(result.unchecked).toBe(4);
        expect(result.nextTaskLabel).toBe('1. Port atlas parser');
    });
});

describe('parsePlanSections — explicit section-scoped entry point', () => {
    it('produces identical results to parsePlanChecklistText', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] 1. task',
            '',
            '## Notes',
            '',
            '- [x] ignored',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. check',
        ].join('\n');

        const fromText: PlanChecklist = parsePlanChecklistText(markdown);
        const fromSections: PlanChecklist = parsePlanSections(markdown);

        expect(fromSections).toEqual(fromText);
        expect(fromSections.total).toBe(2);
    });

    it('ignores checkboxes before the first counted heading', () => {
        const markdown = [
            '- [x] preamble checkbox (no heading yet)',
            '',
            '## TODOs',
            '',
            '- [ ] 1. the only real task',
        ].join('\n');

        const result = parsePlanSections(markdown);

        expect(result.total).toBe(1);
        expect(result.items[0]?.text).toBe('1. the only real task');
    });
});
