import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

type TuiPackageManifest = {
    readonly exports?: Record<string, string>;
};

function readText(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

function readTuiManifest(): TuiPackageManifest {
    const parsed: unknown = JSON.parse(readText('apps/tui/package.json'));
    if (!isManifest(parsed)) {
        throw new Error('apps/tui/package.json is not a TUI package manifest');
    }
    return parsed;
}

function isManifest(value: unknown): value is TuiPackageManifest {
    if (!isRecord(value)) return false;
    return value.exports === undefined || isStringRecord(value.exports);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) return false;
    return Object.values(value).every((item) => typeof item === 'string');
}

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}

describe('TUI provider architecture docs and exports', () => {
    it('exports the provider composition root through package, Vite, and test aliases', () => {
        const manifest = readTuiManifest();
        const viteConfig = readText('apps/tui/vite.config.ts');
        const rootVitestConfig = readText('vitest.config.ts');

        expect(manifest.exports?.['./providers']).toBe('./dist/platform/providers/index.js');
        expect(viteConfig).toContain("'platform/providers/index': sourceEntry('./src/platform/providers/index.tsx')");
        expect(rootVitestConfig).toContain("find: '@mission-control/tui/providers'");
        expect(rootVitestConfig).toContain('platform/providers/index.tsx');
    });

    it('keeps the main TUI barrel importable without exporting provider or OpenTUI modules', async () => {
        const mainBarrel = await import('@mission-control/tui');
        const indexSource = stripComments(readText('apps/tui/src/index.ts'));

        expect(mainBarrel.TUI_PACKAGE_NAME).toBe('@mission-control/tui');
        expect('MissionControlTuiProviders' in mainBarrel).toBe(false);
        expect('useTuiRuntime' in mainBarrel).toBe(false);
        expect(indexSource).not.toContain('@opentui/');
        expect(indexSource).not.toContain('platform/providers');
    });

    it('documents provider ownership, plugin trust, OpenCode references, and deferred surfaces', () => {
        const readme = readText('README.md');
        const tuiGuide = readText('apps/tui/AGENTS.md');
        const requiredReadmeTerms = [
            'TUI provider architecture',
            '@mission-control/tui/providers',
            'persistence ownership',
            'plugin trust contract',
            'OpenCode references map to Mission Control as implementation references only',
            'Epilogue-style context surfaces are deferred',
            'Editor parity is intentionally minimal',
        ] as const;
        const requiredGuideTerms = [
            'Provider architecture',
            '@mission-control/tui/providers',
            'main barrel stays provider-free',
            'Provider-owned persistence',
            'OpenCode references are reference material only',
        ] as const;

        for (const term of requiredReadmeTerms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
        for (const term of requiredGuideTerms) {
            expect(tuiGuide, `apps/tui/AGENTS.md missing ${term}`).toContain(term);
        }
    });
});
