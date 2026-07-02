import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readme(): string {
    return readFileSync(join(root, 'README.md'), 'utf8');
}

describe('README configuration profiles contract', () => {
    it('documents the --profile long-only flag', () => {
        const content = readme();
        const requiredTerms = [
            '--profile <name>',
            'there is no `-p` alias for profile',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents the exact profile filename precedence candidates', () => {
        const content = readme();
        const requiredTerms = [
            'mission-control.<profile>.jsonc',
            'mission-control.<profile>.json',
            'config.<profile>.jsonc',
            'config.<profile>.json',
            'first existing file wins',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents that the profile replaces config.json with no fallback', () => {
        const content = readme();
        expect(content).toContain(
            'the selected profile file replaces `config.json` as the global config input; there is no fallback',
        );
    });

    it('documents JSONC comment support and no trailing comma support', () => {
        const content = readme();
        const requiredTerms = ['stripped before parsing', 'Trailing commas are not supported'] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents the profile-not-found behavior', () => {
        const content = readme();
        expect(content).toContain('does not silently fall back to base config');
    });

    it('documents that project .mcp.json is never profiled', () => {
        const content = readme();
        const requiredTerms = ['.mcp.<profile>.json', 'is ignored'] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents what --profile does NOT affect', () => {
        const content = readme();
        expect(content).toContain('does not change the data directory');
    });

    it('documents a quick-start example using --profile dev', () => {
        const content = readme();
        expect(content).toContain('mctrl mcp list --profile dev');
    });

    it('does NOT document -p as a profile alias', () => {
        const content = readme();
        expect(content).not.toContain('-p, --profile');
        expect(content).not.toContain('--profile, -p');
    });
});
