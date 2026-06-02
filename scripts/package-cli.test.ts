import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

type CliManifest = {
    readonly files?: readonly string[];
    readonly bin?: Record<string, string>;
    readonly publishConfig?: {
        readonly access?: string;
    };
};

function readCliManifest(): CliManifest {
    return JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')) as CliManifest;
}

describe('CLI package distribution contract', () => {
    it('declares publish-ready npm metadata', () => {
        const manifest = readCliManifest();

        expect(manifest.files).toEqual(['dist']);
        expect(manifest.bin?.['mctrl']).toBe('./dist/index.js');
        expect(manifest.publishConfig?.access).toBe('public');
    });

    it('package helper verifies CLI dist and sidecar before creating a current-platform tarball', () => {
        const source = readFileSync(join(root, 'scripts/package-cli.ts'), 'utf8');

        expect(source).toContain('apps/cli/dist/index.js');
        expect(source).toContain('mission-control-sidecar');
        expect(source).toContain('mctrl-${platform.os}-${platform.arch}.tar.gz');
        expect(source).toContain('tar');
    });
});
