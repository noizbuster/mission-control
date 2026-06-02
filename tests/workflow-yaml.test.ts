import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readWorkflow(name: string): string {
    return readFileSync(join(root, '.github/workflows', name), 'utf8');
}

describe('GitHub workflow distribution contract', () => {
    it('ci workflow installs, typechecks, builds, and builds the sidecar', () => {
        const ci = readWorkflow('ci.yml');

        expect(ci).toContain('pnpm install');
        expect(ci).toContain('pnpm typecheck');
        expect(ci).toContain('pnpm build');
        expect(ci).toContain('cargo build --manifest-path native/sidecar/Cargo.toml');
    });

    it('release workflows define CLI and desktop release jobs', () => {
        const releaseCli = readWorkflow('release-cli.yml');
        const releaseDesktop = readWorkflow('release-desktop.yml');

        expect(releaseCli).toContain('v*');
        expect(releaseCli).toContain('pnpm dev:package-cli');
        expect(releaseCli).toContain('NPM_TOKEN');
        expect(releaseCli).toContain('mctrl-${{ matrix.os }}-${{ matrix.arch }}.tar.gz');
        expect(releaseDesktop).toContain('release-desktop');
        expect(releaseDesktop).toContain('tauri');
        expect(releaseDesktop).toContain('signing/notarization TODO');
    });
});
