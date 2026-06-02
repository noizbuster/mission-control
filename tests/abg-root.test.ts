import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('ABG root prerequisite', () => {
    it('root ABG.md exists and matches docs/ABG.md', () => {
        const rootAbg = readFileSync(join(root, 'ABG.md'), 'utf8');
        const docsAbg = readFileSync(join(root, 'docs/ABG.md'), 'utf8');

        expect(rootAbg).toBe(docsAbg);
    });
});
