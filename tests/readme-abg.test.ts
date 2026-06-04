import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('README ABG alignment', () => {
    it('documents reflected concepts, boundaries, and not-implemented ABG features', () => {
        const readme = readFileSync(join(root, 'README.md'), 'utf8');
        const requiredTerms = [
            'ABG.md is the root design reference',
            'Runtime boundary',
            'Protocol boundary',
            'Sidecar boundary',
            'UI/runtime separation',
            'Event Log',
            'Snapshot',
            'not implemented',
            'persistent memory store',
            'vector index',
            'real LLM provider',
            'behavior/action graph engine',
            'Authorable ABG MVP',
            'full production ABG engine',
            'real providers, real tools, durable persistence, and visual graph editor remain out of scope',
        ] as const;

        for (const term of requiredTerms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
    });
});
