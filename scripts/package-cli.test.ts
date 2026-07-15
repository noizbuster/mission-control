import { describe, expect, it } from 'vitest';
import { createCurrentPlatformPackage } from './package-cli.js';
import { packageJson, withPackageFixture, writeFixtureFile } from './package-cli-test-fixture.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const root = process.cwd();

type CliManifest = {
    readonly private?: boolean;
    readonly files?: readonly string[];
    readonly bin?: { readonly mc?: string; readonly mctrl?: string };
    readonly publishConfig?: unknown;
    readonly dependencies?: Readonly<Record<string, string>>;
};

type RuntimeManifest = {
    readonly dependencies?: Readonly<Record<string, string>>;
};

function readCliManifest(): CliManifest {
    return JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')) as CliManifest;
}

describe('CLI package distribution contract', () => {
    it('declares puppeteer-core as a regular core runtime dependency', () => {
        const manifest = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as RuntimeManifest;
        expect(manifest.dependencies?.['puppeteer-core']).toMatch(/^\^?25\./u);
    });

    it('keeps the CLI private without public publication metadata', () => {
        const manifest = readCliManifest();
        expect(manifest.private).toBe(true);
        expect(manifest.files).toEqual(['dist']);
        expect(manifest.bin?.mc).toBe('./dist/index.js');
        expect(manifest.bin?.mctrl).toBe('./dist/index.js');
        expect(manifest.publishConfig).toBeUndefined();
        expect(manifest.dependencies).toMatchObject({
            '@mission-control/config': 'workspace:*',
            '@mission-control/core': 'workspace:*',
            '@mission-control/protocol': 'workspace:*',
            '@mission-control/tui': 'workspace:*',
        });
    });

    it('package helper verifies CLI dist and sidecar before creating a current-platform tarball', () => {
        const source = readFileSync(join(root, 'scripts/package-cli.ts'), 'utf8');
        expect(source).toContain('apps/cli/dist/index.js');
        expect(source).toContain('mission-control-sidecar');
        expect(source).toContain(['mctrl-', '$', '{platform.os}-', '$', '{platform.arch}.tar.gz'].join(''));
        expect(source).toContain('tar');
    });

    it('install script preserves the stable sidecar binary name from release artifacts', () => {
        const source = readFileSync(join(root, 'scripts/install.sh'), 'utf8');
        expect(source).toContain(['artifact="mctrl-', '$', '{os}-', '$', '{arch}.tar.gz"'].join(''));
        expect(source).toContain('mission-control-sidecar');
        expect(source).toContain('artifact did not contain mission-control-sidecar');
        expect(source).toContain('installed mission-control-sidecar');
    });

    it('stages the runnable CLI dist tree, versioned browser dependencies, zod, and sidecar', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const entries = listTarEntries(artifactPath);
            const stageRoot = artifactPath.replace(/\.tar\.gz$/u, '');
            expect(entries).toEqual(
                expect.arrayContaining([
                    './mc',
                    './mctrl',
                    './index.js',
                    './args.js',
                    './commands/run-agent.js',
                    './commands/session.js',
                    './commands/mission-control-services.js',
                    './chunks/args-fixtureHASH.js',
                    './node_modules/@mission-control/config/dist/index.js',
                    './node_modules/@mission-control/core/dist/index.js',
                    './node_modules/@mission-control/core/dist/replay.js',
                    './node_modules/@mission-control/core/dist/redaction.js',
                    './node_modules/@mission-control/core/dist/chunks/observability-fixtureHASH.js',
                    './node_modules/@mission-control/protocol/dist/index.js',
                    './node_modules/@mission-control/tui/dist/index.js',
                    './node_modules/@mission-control/tui/package.json',
                    './node_modules/puppeteer-core/package.json',
                    './node_modules/puppeteer-core/node_modules/zod/transitive-runtime-version.js',
                    './node_modules/zod/correct-runtime-version.js',
                    './node_modules/zod/package.json',
                    './mission-control-sidecar',
                ]),
            );
            expect(entries).not.toEqual(
                expect.arrayContaining([
                    './commands/local-coding-provider.js',
                    './commands/provider-factory.js',
                    './node_modules/@mission-control/config/dist/provider-capabilities.js',
                    './node_modules/@mission-control/core/dist/providers/openai/openai-responses-provider.js',
                ]),
            );
            const shebang = '#!/usr/bin/env -S node --experimental-ffi\n';
            expect(readFileSync(join(stageRoot, 'mc'), 'utf8').startsWith(shebang)).toBe(true);
            expect(readFileSync(join(stageRoot, 'mctrl'), 'utf8').startsWith(shebang)).toBe(true);
            expect(readFileSync(join(stageRoot, 'index.js'), 'utf8').startsWith(shebang)).toBe(true);
            expect(readPackageVersion(join(stageRoot, 'node_modules/zod/package.json'))).toBe('4.4.3');
            expect(
                readPackageVersion(join(stageRoot, 'node_modules/puppeteer-core/node_modules/zod/package.json')),
            ).toBe('3.25.76');
        });
    });

    it('writes a sha256 checksum next to the current-platform tarball', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const expectedDigest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
            expect(readFileSync(`${artifactPath}.sha256`, 'utf8')).toBe(
                `${expectedDigest}  ${basename(artifactPath)}\n`,
            );
        });
    });

    it('stages a private package manifest for the release tarball', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const stageRoot = artifactPath.replace(/\.tar\.gz$/u, '');
            const stagedManifest = JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8')) as {
                readonly private?: boolean;
            };

            expect(stagedManifest.private).toBe(true);
        });
    });

    it('unpacked package smoke runs help and an isolated local prompt', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const unpackRoot = mkdtempSync(join(tmpdir(), 'mission-control-package-unpack-'));
            try {
                const unpack = spawnSync('tar', ['-xzf', artifactPath, '-C', unpackRoot], { encoding: 'utf8' });
                expect(unpack.status).toBe(0);
                const mc = join(unpackRoot, 'mc');
                const legacyMctrl = join(unpackRoot, 'mctrl');
                const help = spawnSync(mc, ['--help'], { encoding: 'utf8' });
                const legacyHelp = spawnSync(legacyMctrl, ['--help'], { encoding: 'utf8' });
                const dataDir = join(unpackRoot, 'data');
                const prompt = spawnSync(
                    mc,
                    ['run', 'package smoke', '--jsonl', '--provider', 'local', '--model', 'local-echo'],
                    {
                        encoding: 'utf8',
                        env: {
                            ...process.env,
                            MCTRL_DATA_DIR: dataDir,
                            MISSION_CONTROL_AUTH_FILE: join(unpackRoot, 'auth.json'),
                        },
                    },
                );
                expect(help.status).toBe(0);
                expect(help.stdout).toContain('Usage: mc');
                expect(legacyHelp.status).toBe(0);
                expect(legacyHelp.stdout).toContain('Usage: mc');
                expect(prompt.status).toBe(0);
                expect(prompt.stdout).toContain('received prompt: package smoke');
                expect(existsSync(join(dataDir, 'session_fixture.jsonl'))).toBe(true);
            } finally {
                rmSync(unpackRoot, { recursive: true, force: true });
            }
        });
    });

    it('rejects a package fixture when the sidecar binary is missing', () => {
        withPackageFixture({ includeSidecar: false }, (fixtureRoot) => {
            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('mission-control-sidecar binary missing');
        });
    });

    it('rejects dependency names that can escape node_modules', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            writeFixtureFile(
                join(fixtureRoot, 'packages/core/package.json'),
                packageJson('@mission-control/core', { '.': './dist/index.js' }, { '../../outside': 'fixture' }),
            );
            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('invalid dependency package name');
        });
    });

    it('rejects dependency symlinks that resolve outside the package workspace', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const outsideRoot = mkdtempSync(join(tmpdir(), 'mission-control-package-outside-'));
            try {
                writeFixtureFile(
                    join(outsideRoot, 'package.json'),
                    packageJson('puppeteer-core', { '.': './index.js' }),
                );
                writeFixtureFile(join(outsideRoot, 'index.js'), 'export const escaped = true;\n');
                const source = join(fixtureRoot, 'node_modules/puppeteer-core');
                rmSync(source, { recursive: true, force: true });
                symlinkSync(outsideRoot, source, 'dir');
                expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('source for puppeteer-core escapes');
            } finally {
                rmSync(outsideRoot, { recursive: true, force: true });
            }
        });
    });

    it('rejects dependency symlinks that escape their package inside the workspace', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const dependencyRoot = join(fixtureRoot, 'node_modules/puppeteer-core');
            symlinkSync(
                join(fixtureRoot, 'packages/core/package.json'),
                join(dependencyRoot, 'leaked-core-package.json'),
            );

            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('escapes package root');
        });
    });

    it('rejects an installed dependency version outside the requested range', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            writeFixtureFile(
                join(fixtureRoot, 'packages/core/package.json'),
                packageJson('@mission-control/core', { '.': './dist/index.js' }, { 'puppeteer-core': '^25.3.0' }),
            );
            writeFixtureFile(
                join(fixtureRoot, 'node_modules/puppeteer-core/package.json'),
                packageJson('puppeteer-core', { '.': './index.js' }, { zod: 'transitive-fixture' }, '24.0.0'),
            );

            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('does not satisfy ^25.3.0');
        });
    });

    it('rejects an undeclared prerelease for a stable requested range', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            writeFixtureFile(
                join(fixtureRoot, 'node_modules/puppeteer-core/package.json'),
                packageJson('puppeteer-core', { '.': './index.js' }, { zod: '^3.25.0' }, '25.3.0-evil'),
            );

            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('does not satisfy ^25.3.0');
        });
    });

    it('rejects a later undeclared prerelease inside a stable requested range', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            writeFixtureFile(
                join(fixtureRoot, 'node_modules/puppeteer-core/package.json'),
                packageJson('puppeteer-core', { '.': './index.js' }, { zod: '^3.25.0' }, '25.4.0-evil'),
            );

            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('does not satisfy ^25.3.0');
        });
    });

    it('rejects a different prerelease for an exact prerelease request', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            writeFixtureFile(
                join(fixtureRoot, 'packages/core/package.json'),
                packageJson(
                    '@mission-control/core',
                    { '.': './dist/index.js' },
                    { 'puppeteer-core': '=25.3.0-evil.2' },
                ),
            );
            writeFixtureFile(
                join(fixtureRoot, 'node_modules/puppeteer-core/package.json'),
                packageJson('puppeteer-core', { '.': './index.js' }, { zod: '^3.25.0' }, '25.3.0-evil'),
            );

            expect(() => createCurrentPlatformPackage(fixtureRoot)).toThrow('does not satisfy =25.3.0-evil.2');
        });
    });
});

function listTarEntries(artifactPath: string): readonly string[] {
    const tar = spawnSync('tar', ['-tzf', artifactPath], { encoding: 'utf8' });
    expect(tar.status).toBe(0);
    return tar.stdout.trim().split('\n');
}

function readPackageVersion(manifestPath: string): string | undefined {
    return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly version?: string }).version;
}
