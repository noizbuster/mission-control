import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type PackageFixtureOptions = {
    readonly includeSidecar: boolean;
};

export function withPackageFixture(options: PackageFixtureOptions, run: (fixtureRoot: string) => void): void {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mission-control-package-fixture-'));
    try {
        writePackageFixture(fixtureRoot, options);
        run(fixtureRoot);
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

export function writePackageFixture(fixtureRoot: string, options: PackageFixtureOptions): void {
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/package.json'),
        packageJson('@mission-control/cli', {
            '.': './dist/index.js',
            './args': './dist/args.js',
            './commands/run-agent': './dist/commands/run-agent.js',
            './commands/session': './dist/commands/session.js',
            './commands/mission-control-services': './dist/commands/mission-control-services.js',
        }),
    );
    writeFixtureFile(join(fixtureRoot, 'apps/cli/dist/index.js'), fixtureCliEntrypoint());
    writeFixtureFile(join(fixtureRoot, 'apps/cli/dist/args.js'), 'export const args = [];\n');
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/commands/run-agent.js'),
        'export async function runAgent() {}\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/commands/session.js'),
        'export async function runSessionCommand() {}\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/commands/mission-control-services.js'),
        'export function getOrCreateMissionControlServices() {}\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'apps/cli/dist/chunks/args-fixtureHASH.js'),
        'export const chunk = true;\n',
    );

    writeFixtureFile(
        join(fixtureRoot, 'packages/config/package.json'),
        packageJson('@mission-control/config', { '.': './dist/index.js' }),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/config/dist/index.js'), 'export const config = true;\n');

    writeFixtureFile(
        join(fixtureRoot, 'packages/core/package.json'),
        packageJson(
            '@mission-control/core',
            {
                '.': './dist/index.js',
                './replay': './dist/replay.js',
                './redaction': './dist/redaction.js',
            },
            { 'puppeteer-core': '^25.3.0' },
        ),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/core/dist/index.js'), 'export const core = true;\n');
    writeFixtureFile(join(fixtureRoot, 'packages/core/dist/replay.js'), 'export const replay = true;\n');
    writeFixtureFile(join(fixtureRoot, 'packages/core/dist/redaction.js'), 'export const redaction = true;\n');
    writeFixtureFile(
        join(fixtureRoot, 'packages/core/dist/chunks/observability-fixtureHASH.js'),
        'export const coreChunk = true;\n',
    );

    writeFixtureFile(
        join(fixtureRoot, 'packages/protocol/package.json'),
        packageJson('@mission-control/protocol', { '.': './dist/index.js' }, { zod: '^4.4.0' }),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/protocol/dist/index.js'), 'export const protocol = true;\n');

    writeFixtureFile(
        join(fixtureRoot, 'apps/tui/package.json'),
        packageJson('@mission-control/tui', { '.': './dist/index.js' }),
    );
    writeFixtureFile(join(fixtureRoot, 'apps/tui/dist/index.js'), 'export const tui = true;\n');

    writeFixtureFile(
        join(fixtureRoot, 'packages/protocol/node_modules/zod/package.json'),
        packageJson('zod', { '.': './index.js' }, undefined, '4.4.3'),
    );
    writeFixtureFile(join(fixtureRoot, 'packages/protocol/node_modules/zod/index.js'), 'export const z = {};\n');
    writeFixtureFile(
        join(fixtureRoot, 'packages/protocol/node_modules/zod/correct-runtime-version.js'),
        'export const correct = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'node_modules/.pnpm/node_modules/zod/package.json'),
        packageJson('zod', { '.': './index.js' }, undefined, '3.25.76'),
    );
    writeFixtureFile(
        join(fixtureRoot, 'node_modules/.pnpm/node_modules/zod/transitive-runtime-version.js'),
        'export const transitive = true;\n',
    );
    writeFixtureFile(
        join(fixtureRoot, 'node_modules/puppeteer-core/package.json'),
        packageJson('puppeteer-core', { '.': './index.js' }, { zod: '^3.25.0' }, '25.3.0'),
    );
    writeFixtureFile(join(fixtureRoot, 'node_modules/puppeteer-core/index.js'), 'export const connect = true;\n');

    if (options.includeSidecar) {
        const sidecarPath = join(fixtureRoot, 'native/sidecar/target/debug/mission-control-sidecar');
        writeFixtureFile(sidecarPath, '#!/usr/bin/env sh\necho sidecar\n');
        chmodSync(sidecarPath, 0o755);
    }
}

export function writeFixtureFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

export function packageJson(
    name: string,
    exportsMap: Record<string, string>,
    dependencies?: Record<string, string>,
    version = '1.0.0',
): string {
    return `${JSON.stringify({ name, version, type: 'module', exports: exportsMap, dependencies }, null, 2)}\n`;
}

function fixtureCliEntrypoint(): string {
    return [
        '#!/usr/bin/env -S node --experimental-ffi',
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        '',
        "if (process.argv.includes('--help')) {",
        "    console.log('Usage: mc');",
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
