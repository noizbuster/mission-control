import { describe, expect, it } from 'vitest';
import { createCurrentPlatformPackage } from './package-cli.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const root = process.cwd();

type CliManifest = {
    readonly files?: readonly string[];
    readonly bin?: {
        readonly mctrl?: string;
    };
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
        expect(manifest.bin?.mctrl).toBe('./dist/index.js');
        expect(manifest.publishConfig?.access).toBe('public');
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

    it('stages the runnable CLI dist tree, provider packages, zod, and sidecar in the tarball', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const entries = listTarEntries(artifactPath);

            expect(entries).toEqual(
                expect.arrayContaining([
                    './mctrl',
                    './args.js',
                    './commands/local-coding-provider.js',
                    './commands/provider-factory.js',
                    './node_modules/@mission-control/config/dist/provider-capabilities.js',
                    './node_modules/@mission-control/core/dist/providers/openai/openai-responses-provider.js',
                    './node_modules/@mission-control/protocol/dist/index.js',
                    './node_modules/zod/package.json',
                    './mission-control-sidecar',
                ]),
            );
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

    it('unpacked package smoke runs help and an isolated local prompt', () => {
        withPackageFixture({ includeSidecar: true }, (fixtureRoot) => {
            const artifactPath = createCurrentPlatformPackage(fixtureRoot);
            const unpackRoot = mkdtempSync(join(tmpdir(), 'mission-control-package-unpack-'));

            try {
                const unpack = spawnSync('tar', ['-xzf', artifactPath, '-C', unpackRoot], { encoding: 'utf8' });
                expect(unpack.status).toBe(0);

                const mctrl = join(unpackRoot, 'mctrl');
                const help = spawnSync(mctrl, ['--help'], { encoding: 'utf8' });
                const dataDir = join(unpackRoot, 'data');
                const authFile = join(unpackRoot, 'auth.json');
                const prompt = spawnSync(
                    mctrl,
                    ['run', 'package smoke', '--jsonl', '--provider', 'local', '--model', 'local-echo'],
                    {
                        encoding: 'utf8',
                        env: {
                            ...process.env,
                            MCTRL_DATA_DIR: dataDir,
                            MISSION_CONTROL_AUTH_FILE: authFile,
                        },
                    },
                );

                expect(help.status).toBe(0);
                expect(help.stdout).toContain('Usage: mctrl');
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
});

type PackageFixtureOptions = {
    readonly includeSidecar: boolean;
};

function withPackageFixture(options: PackageFixtureOptions, run: (fixtureRoot: string) => void): void {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mission-control-package-fixture-'));
    try {
        writePackageFixture(fixtureRoot, options);
        run(fixtureRoot);
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

function writePackageFixture(fixtureRoot: string, options: PackageFixtureOptions): void {
    writeFixtureFile(join(fixtureRoot, 'apps/cli/dist/index.js'), fixtureCliEntrypoint());
    writeFixtureFile(join(fixtureRoot, 'apps/cli/dist/args.js'), 'export const args = [];\n');
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/commands/local-coding-provider.js'),
        'export const local = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/commands/provider-factory.js'),
        'export const provider = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'packages/config/package.json'),
        packageJson('@mission-control/config', { '.': './dist/index.js' }),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/config/dist/index.js'), 'export const config = true;\n');
    writeFixtureFile(
        join(fixtureRoot, 'packages/config/dist/provider-capabilities.js'),
        'export const capabilities = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'packages/core/package.json'),
        packageJson('@mission-control/core', { '.': './dist/index.js' }),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/core/dist/index.js'), 'export const core = true;\n');
    writeFixtureFile(
        join(fixtureRoot, 'packages/core/dist/providers/openai/openai-responses-provider.js'),
        'export const openai = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'packages/protocol/package.json'),
        packageJson('@mission-control/protocol', { '.': './dist/index.js' }),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/protocol/dist/index.js'), 'export const protocol = true;\n');
    writeFixtureFile(join(fixtureRoot, 'node_modules/zod/package.json'), packageJson('zod', { '.': './index.js' }));
    writeFixtureFile(join(fixtureRoot, 'node_modules/zod/index.js'), 'export const z = {};\n');

    if (options.includeSidecar) {
        const sidecarPath = join(fixtureRoot, 'native/sidecar/target/debug/mission-control-sidecar');
        writeFixtureFile(sidecarPath, '#!/usr/bin/env sh\necho sidecar\n');
        chmodSync(sidecarPath, 0o755);
    }
}

function writeFixtureFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

function packageJson(name: string, exportsMap: Record<string, string>): string {
    return `${JSON.stringify({ name, type: 'module', exports: exportsMap }, null, 2)}\n`;
}

function fixtureCliEntrypoint(): string {
    return [
        '#!/usr/bin/env node',
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        '',
        "if (process.argv.includes('--help')) {",
        "    console.log('Usage: mctrl');",
        '    process.exit(0);',
        '}',
        '',
        "if (process.argv[2] === 'run') {",
        "    const dataDir = process.env.MCTRL_DATA_DIR ?? '';",
        '    if (dataDir.length === 0) {',
        "        console.error('MCTRL_DATA_DIR is required for package smoke');",
        '        process.exit(1);',
        '    }',
        '    mkdirSync(dataDir, { recursive: true });',
        "    const prompt = process.argv[3] ?? '';",
        "    writeFileSync(join(dataDir, 'session_fixture.jsonl'), JSON.stringify({ prompt }) + '\\n');",
        "    console.log(JSON.stringify({ type: 'task.completed', message: 'received prompt: ' + prompt }));",
        '    process.exit(0);',
        '}',
        '',
        "console.error('unsupported fixture command');",
        'process.exit(1);',
        '',
    ].join('\n');
}

function listTarEntries(artifactPath: string): readonly string[] {
    const tar = spawnSync('tar', ['-tzf', artifactPath], { encoding: 'utf8' });
    expect(tar.status).toBe(0);
    return tar.stdout.trim().split('\n');
}
