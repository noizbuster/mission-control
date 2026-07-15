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
        expect(ci).toContain('fetch-depth: 0');
        expect(ci).toContain('permissions:\n  contents: read');
        expect(ci).toContain('persist-credentials: false');
        expect(ci).toContain('node-version: 26.3.0');
        expect(ci).toContain('pnpm check:changed-ts-size');
        expect(ci).toContain('github.event.pull_request.base.sha');
        expect(ci).toContain('github.event.before');
        expect(ci).toContain('pnpm test');
        expect(ci).toContain('pnpm typecheck');
        expect(ci).toContain('pnpm build');
        expect(ci).toContain('pnpm lint');
        expect(ci).toContain('cargo test --manifest-path native/sidecar/Cargo.toml');
        expect(ci).toContain('cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml');
        expect(ci).toContain('cargo build --manifest-path native/sidecar/Cargo.toml');
        expect(ci.indexOf('pnpm check:changed-ts-size')).toBeLessThan(ci.indexOf('pnpm test'));
        expect(ci.indexOf('pnpm test')).toBeLessThan(ci.indexOf('pnpm build'));
        expect(ci).not.toContain('OPENAI_API_KEY');
        expect(ci).not.toContain('OPENAI_LIVE');
    });

    it('release workflows define CLI and desktop release jobs', () => {
        const releaseCli = readWorkflow('release-cli.yml');
        const releaseDesktop = readWorkflow('release-desktop.yml');

        expect(releaseCli).toContain('v*');
        expect(releaseCli).toContain('pnpm dev:package-cli');
        expect(releaseCli).not.toMatch(/\b(?:npm|pnpm)\b[^\n]*\bpublish\b/u);
        expect(releaseCli).not.toContain('NPM_TOKEN');
        expect(releaseCli).not.toContain('NODE_AUTH_TOKEN');
        expect(releaseCli).not.toContain('registry-url');
        expect(releaseCli).not.toContain('_authToken');
        expect(releaseCli).not.toContain('registry.npmjs.org');
        expect(releaseCli).not.toContain('npm.pkg.github.com');
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

    it('release JS steps pin Node and build the CLI dependency graph before packaging', () => {
        const releaseCli = readWorkflow('release-cli.yml');
        const releaseDesktop = readWorkflow('release-desktop.yml');
        const cliBuild = 'NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:build';
        const sidecarBuild = 'cargo build --release --manifest-path native/sidecar/Cargo.toml';
        const packageCli = 'pnpm dev:package-cli';
        const uploadRelease = 'uses: softprops/action-gh-release@v2';

        expect(releaseCli).toContain('node-version: 26.3.0');
        expect(releaseDesktop).toContain('node-version: 26.3.0');
        expect(releaseCli).not.toContain('pnpm --filter @mission-control/cli build');
        expect(releaseCli).toContain(cliBuild);
        expect(releaseCli.indexOf(cliBuild)).toBeLessThan(releaseCli.indexOf(sidecarBuild));
        expect(releaseCli.indexOf(sidecarBuild)).toBeLessThan(releaseCli.indexOf(packageCli));
        expect(releaseCli.indexOf(packageCli)).toBeLessThan(releaseCli.indexOf(uploadRelease));
    });
});
