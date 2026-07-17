import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readmeContent = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('README desktop tool contract', () => {
    it('documents the CLI-primary and desktop re-execution capability split', () => {
        const requiredTerms = [
            'Desktop scope',
            '`repo.read.tagged`',
            '`glob`',
            '`hashline_edit`',
            'fresh registry',
            'CLI-primary',
            '`ast_edit` / `resolve`',
            '`job`',
            '`monitor_*`',
            '`shell.session`',
            '`ssh`',
            '`lsp_rename`',
            'does not claim full desktop effectful-tool parity',
        ] as const;

        for (const term of requiredTerms) {
            expect(readmeContent, `README missing ${term}`).toContain(term);
        }
    });
});
