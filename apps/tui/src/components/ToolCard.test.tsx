import { describe, expect, it } from 'vitest';
import { buildHeaderLabel, hasDiffContent, ToolCard } from './ToolCard.js';

describe('hasDiffContent', () => {
    it('returns true when a block contains added/removed diff lines', () => {
        const lines = [
            'Edit preview for file.edit',
            'Target: src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '-old line',
            '+new line',
        ];
        expect(hasDiffContent(lines)).toBe(true);
    });

    it('returns true for a standalone removed line', () => {
        expect(hasDiffContent(['-only removed'])).toBe(true);
    });

    it('returns true for a standalone added line', () => {
        expect(hasDiffContent(['+only added'])).toBe(true);
    });

    it('returns true for hunk markers without +/- lines', () => {
        expect(hasDiffContent(['@@ -1,3 +1,4 @@'])).toBe(true);
    });

    it('returns true for +++ / --- meta lines', () => {
        expect(hasDiffContent(['+++ b/foo.ts', '--- a/foo.ts'])).toBe(true);
    });

    it('returns false for pure prose lines', () => {
        const lines = ['Command preview for command.run', '$ ls -la', 'Command output for bash.run'];
        expect(hasDiffContent(lines)).toBe(false);
    });

    it('returns false for a Target line without any +/- or @@ markers', () => {
        expect(hasDiffContent(['Target: src/app.ts'])).toBe(false);
    });

    it('returns false for an empty array', () => {
        expect(hasDiffContent([])).toBe(false);
    });

    it('does not treat mid-string dashes as diff markers', () => {
        expect(hasDiffContent(['some - inline text', 'a + b = c'])).toBe(false);
    });
});

describe('buildHeaderLabel', () => {
    it('uses the provided title when expanded', () => {
        expect(buildHeaderLabel('file.edit', 5, true)).toBe('> file.edit');
    });

    it('appends a line-count hint when collapsed', () => {
        expect(buildHeaderLabel('file.edit', 5, false)).toBe('> file.edit (5 lines)');
    });

    it('falls back to a generic label when title is undefined', () => {
        expect(buildHeaderLabel(undefined, 3, true)).toBe('> Tool output');
    });

    it('shows the line-count hint with the fallback title when collapsed', () => {
        expect(buildHeaderLabel(undefined, 3, false)).toBe('> Tool output (3 lines)');
    });

    it('produces different output for collapsed vs expanded (body-present flag)', () => {
        const expandedHeader = buildHeaderLabel('patch.ts', 10, true);
        const collapsedHeader = buildHeaderLabel('patch.ts', 10, false);
        expect(expandedHeader).not.toBe(collapsedHeader);
        expect(expandedHeader).toBe('> patch.ts');
        expect(collapsedHeader).toBe('> patch.ts (10 lines)');
    });
});

describe('ToolCard component', () => {
    it('is a callable React component', () => {
        expect(typeof ToolCard).toBe('function');
    });

    it('does not throw when constructed with a diff block', () => {
        expect(() => {
            void (<ToolCard lines={['+added', '-removed']} expanded={true} />);
        }).not.toThrow();
    });

    it('does not throw when constructed with a prose block collapsed', () => {
        expect(() => {
            void (
                <ToolCard lines={['Command preview for command.run', '$ ls']} title="command.run" expanded={false} />
            );
        }).not.toThrow();
    });
});
