import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('README extension points', () => {
    it('documents all stage 05 extension sections', () => {
        const readme = readFileSync(join(root, 'README.md'), 'utf8');
        const terms = [
            'ABG-based extension points',
            'Sub-agent model',
            'Behavior/action graph plan',
            'Scheduler/executor split',
            'Memory/event model',
            'Native sidecar future role',
            'Renderer future role',
            'placeholder only',
            'not implemented',
        ] as const;

        for (const term of terms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
    });
});
