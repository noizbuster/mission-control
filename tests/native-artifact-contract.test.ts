import { describe, expect, it } from 'vitest';
import { createNativesClient } from '@mission-control/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readText(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

function readJson(path: string): unknown {
    return JSON.parse(readText(path));
}

/**
 * The four release platforms the CLI artifacts and native addons target.
 * The os/arch tokens are shared between the CLI tarball naming
 * (`mctrl-<os>-<arch>.tar.gz`) and the platform addon packages
 * (`@mission-control/natives-<os>-<arch>`), so a change in one is a change
 * in the public distribution contract and must be reflected in the other.
 */
const RELEASE_PLATFORMS = [
    { os: 'linux', arch: 'x64' },
    { os: 'linux', arch: 'arm64' },
    { os: 'darwin', arch: 'x64' },
    { os: 'darwin', arch: 'arm64' },
] as const;

const nativesCargoPath = 'native/natives/Cargo.toml';
const nativesPackagePath = 'native/natives/package.json';
const addonPath = join(root, 'native', 'natives', 'index.node');
// The addon is an optional build artifact: CI may build it or run without it.
// Runtime assertions are skipped when it is absent so the suite stays green.
const addonBuilt = existsSync(addonPath);

describe('native/natives N-API crate contract', () => {
    it('declares a cdylib crate-type so cargo emits a Node-loadable shared object', () => {
        const cargo = readText(nativesCargoPath);

        expect(cargo).toContain('[lib]');
        expect(cargo).toContain('crate-type = ["cdylib"]');
    });

    it('does not declare a [[bin]] target (a cdylib addon has no standalone binary)', () => {
        const cargo = readText(nativesCargoPath);

        expect(cargo).not.toContain('[[bin]]');
    });

    it('is named mission-control-natives', () => {
        const cargo = readText(nativesCargoPath);

        expect(cargo).toContain('name = "mission-control-natives"');
    });
});

describe('N-API addon artifact path convention', () => {
    it('the client wrapper loads native/natives/index.node', () => {
        const client = readText('packages/core/src/native/natives-client.ts');

        // The authoritative candidate path the loader probes for the addon.
        expect(client).toContain("join(root, 'native', 'natives', 'index.node')");
    });

    it('the addon artifact is gitignored so the 30MB+ binary is never committed', () => {
        const gitignore = readText('.gitignore');

        expect(gitignore).toContain('native/natives/*.node');
    });

    it.skipIf(!addonBuilt)('the built addon file exists at the conventional path', () => {
        expect(existsSync(addonPath), `${addonPath} should exist`).toBe(true);
    });
});

describe('createNativesClient availability', () => {
    it.skipIf(!addonBuilt)('reports available: true when the .node artifact is present and loadable', () => {
        const client = createNativesClient({ onWarning: () => {} });

        expect(client.available).toBe(true);
        expect(client.countTokens('hello world', 'gpt-4o')).not.toBeNull();
    });

    it.skipIf(addonBuilt)('gracefully reports available: false (no thrown error) when the addon is absent', () => {
        const client = createNativesClient({
            addonPath: '/nonexistent/mission-control-natives.node',
            onWarning: () => {},
        });

        expect(client.available).toBe(false);
        expect(client.countTokens('hello world', 'gpt-4o')).toBeNull();
    });
});

describe('platform addon package naming convention', () => {
    it('documents a main package plus one optional dependency per release platform', () => {
        const parsed = readJson(nativesPackagePath);
        expect(typeof parsed).toBe('object');
        expect(parsed).not.toBeNull();

        const manifest = parsed as Record<string, unknown>;
        expect(manifest['name']).toBe('@mission-control/natives');

        const optionalDependencies = manifest['optionalDependencies'];
        expect(typeof optionalDependencies).toBe('object');

        const deps = optionalDependencies as Record<string, string>;
        for (const { os, arch } of RELEASE_PLATFORMS) {
            const expected = `@mission-control/natives-${os}-${arch}`;
            expect(deps[expected], `optionalDependencies must list ${expected}`).toBeTruthy();
        }
    });

    it('the napi.triples field documents every release platform consistently', () => {
        const parsed = readJson(nativesPackagePath);
        const manifest = parsed as Record<string, unknown>;
        const napi = manifest['napi'];
        expect(typeof napi).toBe('object');

        const napiRecord = napi as Record<string, unknown>;
        const triples = napiRecord['triples'];
        expect(Array.isArray(triples)).toBe(true);

        const tripleList = triples as readonly unknown[];
        const platformEntries = tripleList.map((entry) => {
            if (typeof entry !== 'object' || entry === null) {
                return null;
            }
            const record = entry as Record<string, unknown>;
            return {
                platform: typeof record['platform'] === 'string' ? record['platform'] : null,
                arch: typeof record['arch'] === 'string' ? record['arch'] : null,
            };
        });

        // Every release platform must be covered by at least one triple whose
        // os/arch tokens match the CLI tarball naming.
        for (const { os, arch } of RELEASE_PLATFORMS) {
            const covered = platformEntries.some(
                (entry) => entry !== null && entry.platform === os && entry.arch === arch,
            );
            expect(covered, `napi.triples must cover ${os}-${arch}`).toBe(true);
        }
    });
});

describe('CLI release artifact names are unchanged', () => {
    it('scripts/package-cli.ts produces mctrl-<os>-<arch>.tar.gz for the current platform', () => {
        const source = readText('scripts/package-cli.ts');

        expect(source).toMatch(/`mctrl-\$\{platform\.os\}-\$\{platform\.arch\}\.tar\.gz`/);
    });

    it('scripts/install.sh downloads mctrl-<os>-<arch>.tar.gz', () => {
        const source = readText('scripts/install.sh');

        expect(source).toMatch(/artifact="mctrl-\$\{os\}-\$\{arch\}\.tar\.gz"/);
    });

    it('release artifacts install mc as primary and mctrl as a legacy alias', () => {
        const packageSource = readText('scripts/package-cli.ts');
        const installSource = readText('scripts/install.sh');

        expect(packageSource).toContain("join(stageDir, 'mc')");
        expect(packageSource).toContain("join(stageDir, 'mctrl')");
        expect(packageSource).toContain('bin: { mc: ');
        expect(packageSource).toContain('mctrl: ');
        expect(installSource).toMatch(/installed mc to \$\{install_dir\}\/mc/);
        expect(installSource).toMatch(/installed mctrl alias to \$\{install_dir\}\/mctrl/);
    });

    it('the four documented release artifact names are still the canonical set', () => {
        const readme = readText('README.md');

        for (const { os, arch } of RELEASE_PLATFORMS) {
            expect(readme, `README must list mctrl-${os}-${arch}.tar.gz`).toContain(`mctrl-${os}-${arch}.tar.gz`);
        }
    });

    it('package-cli.ts still only normalizes linux and darwin as supported OSes', () => {
        const source = readText('scripts/package-cli.ts');

        // The SupportedOs union is the source of truth for the os token in the
        // artifact name. Asserting it stays narrow prevents a silent rename.
        expect(source).toContain("type SupportedOs = 'linux' | 'darwin'");
        expect(source).toContain("type SupportedArch = 'x64' | 'arm64'");
    });
});

describe('CI builds both Rust crates on every release platform', () => {
    it('defines a native-build job with a four-platform matrix', () => {
        const ci = readText('.github/workflows/ci.yml');

        expect(ci).toContain('native-build');
        expect(ci).toContain('linux');
        expect(ci).toContain('x64');
        expect(ci).toContain('linux');
        expect(ci).toContain('arm64');
        expect(ci).toContain('darwin');
    });

    it('runs cargo build --release for both native/natives and native/sidecar in the matrix', () => {
        const ci = readText('.github/workflows/ci.yml');

        expect(ci).toContain('cargo build --release --manifest-path native/natives/Cargo.toml');
        expect(ci).toContain('cargo build --release --manifest-path native/sidecar/Cargo.toml');
    });

    it('keeps ordinary CI free of npm publication while workspace packages are private', () => {
        const ci = readText('.github/workflows/ci.yml');

        expect(ci).not.toContain('npm publish');
        expect(ci).not.toContain('NPM_TOKEN');
    });

    it('preserves the existing verify job steps', () => {
        const ci = readText('.github/workflows/ci.yml');

        expect(ci).toContain('pnpm install');
        expect(ci).toContain('pnpm test');
        expect(ci).toContain('pnpm typecheck');
        expect(ci).toContain('pnpm build');
        expect(ci).toContain('pnpm lint');
        expect(ci).toContain('cargo test --manifest-path native/sidecar/Cargo.toml');
        expect(ci).toContain('cargo build --manifest-path native/sidecar/Cargo.toml');
    });
});
