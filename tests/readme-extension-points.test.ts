import { AbgGraphSpecSchema } from '@mission-control/protocol';
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

    it('documents ABG authorable MVP and example graph files', () => {
        const readme = readFileSync(join(root, 'README.md'), 'utf8');
        const terms = [
            'Authorable ABG MVP',
            'pnpm dev:cli -- --json --graph examples/abg/research-answer.graph.json',
            'local provider/model variant',
            'real providers, real tools, durable persistence, and visual graph editor remain out of scope',
        ] as const;

        for (const term of terms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
    });

    it('parses ABG example graph files', () => {
        const validExamples = [
            'research-answer.graph.json',
            'policy-block.graph.json',
            'parallel-race.graph.json',
        ] as const;

        for (const fileName of validExamples) {
            const raw = readFileSync(join(root, 'examples/abg', fileName), 'utf8');
            expect(AbgGraphSpecSchema.safeParse(JSON.parse(raw)).success, `${fileName} should parse`).toBe(true);
        }

        const malformed = JSON.parse(readFileSync(join(root, 'examples/abg/malformed-edge.graph.json'), 'utf8'));
        const parsed = AbgGraphSpecSchema.safeParse(malformed);
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.message)).toContain('unknown ABG edge target: missing');
    });
});
