import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const githubExpressionPrefix = '$';

function readWorkflow(name: string): string {
    return readFileSync(join(root, '.github/workflows', name), 'utf8');
}

describe('GitHub workflow distribution contract', () => {
    it('ci workflow installs, tests, lints, builds, and tests Rust surfaces without live provider secrets', () => {
        const ci = readWorkflow('ci.yml');

        expect(ci).toContain('pnpm install');
        expect(ci).toContain('pnpm test');
        expect(ci).toContain('pnpm typecheck');
        expect(ci).toContain('pnpm build');
        expect(ci).toContain('pnpm lint');
        expect(ci).toContain('cargo test --manifest-path native/sidecar/Cargo.toml');
        expect(ci).toContain('cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml');
        expect(ci).toContain('cargo build --manifest-path native/sidecar/Cargo.toml');
        expect(ci).not.toContain('OPENAI_API_KEY');
        expect(ci).not.toContain('OPENAI_LIVE');
    });

    it('release workflows define CLI and desktop release jobs', () => {
        const releaseCli = readWorkflow('release-cli.yml');
        const releaseDesktop = readWorkflow('release-desktop.yml');

        expect(releaseCli).toContain('v*');
        expect(releaseCli).toContain('pnpm dev:package-cli');
        expect(releaseCli).toContain('NPM_TOKEN');
        expect(releaseCli).toContain('os: linux');
        expect(releaseCli).toContain('arch: x64');
        expect(releaseCli).toContain('os: darwin');
        expect(releaseCli).toContain('arch: arm64');
        expect(releaseCli).toContain(
            `mctrl-${githubExpressionPrefix}{{ matrix.os }}-${githubExpressionPrefix}{{ matrix.arch }}.tar.gz`,
        );
        expect(releaseCli).toContain(
            `mctrl-${githubExpressionPrefix}{{ matrix.os }}-${githubExpressionPrefix}{{ matrix.arch }}.tar.gz.sha256`,
        );
        expect(releaseDesktop).toContain('release-desktop');
        expect(releaseDesktop).toContain('tauri');
        expect(releaseDesktop).toContain('signing/notarization TODO');
    });
});
