import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('ABG root prerequisite', () => {
    it('uses root ABG.md as the sole English design reference', () => {
        const rootAbg = readFileSync(join(root, 'ABG.md'), 'utf8');

        expect(rootAbg.trim().length).toBeGreaterThan(0);
        expect(existsSync(join(root, 'docs/ABG.md'))).toBe(false);
    });

    it('does not claim deferred visual graph editing is available in current ABG docs', () => {
        const docs = [
            readFileSync(join(root, 'ABG.md'), 'utf8'),
            readFileSync(join(root, 'docs/ABG.ko.md'), 'utf8'),
        ] as const;

        for (const content of docs) {
            expect(content).not.toContain('Desktop application is suitable for visual graph editing');
            expect(content).not.toContain('Desktop App은 시각적 graph 편집과 timeline 분석에 적합하다');
        }
    });
});
