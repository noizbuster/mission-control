import { stageExternalPackages } from './package-cli-dependencies.ts';
import { copyContainedDirectory } from './package-cli-files.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

type SupportedOs = 'linux' | 'darwin';
type SupportedArch = 'x64' | 'arm64';

type PackagePlatform = {
    readonly os: SupportedOs;
    readonly arch: SupportedArch;
};

const workspacePackages = [
    { name: '@mission-control/protocol', source: 'packages/protocol' },
    { name: '@mission-control/config', source: 'packages/config' },
    { name: '@mission-control/core', source: 'packages/core' },
    { name: '@mission-control/tui', source: 'apps/tui' },
] as const;

export function detectPlatform(os = process.platform, arch = process.arch): PackagePlatform {
    return { os: normalizeOs(os), arch: normalizeArch(arch) };
}

export function getArtifactName(platform: PackagePlatform): string {
    return `mctrl-${platform.os}-${platform.arch}.tar.gz`;
}

export function resolveSidecarBinary(root: string): string {
    const releaseBinary = join(root, 'native/sidecar/target/release/mission-control-sidecar');
    const debugBinary = join(root, 'native/sidecar/target/debug/mission-control-sidecar');
    if (existsSync(releaseBinary)) return releaseBinary;
    if (existsSync(debugBinary)) return debugBinary;
    throw new Error(
        'mission-control-sidecar binary missing; run cargo build --manifest-path native/sidecar/Cargo.toml',
    );
}

export function createCurrentPlatformPackage(root = process.cwd()): string {
    const platform = detectPlatform();
    const artifactName = getArtifactName(platform);
    const cliDistDir = join(root, 'apps/cli/dist');
    const cliEntry = join(cliDistDir, 'index.js');
    if (!existsSync(cliEntry)) {
        throw new Error('apps/cli/dist/index.js missing; run pnpm --filter @mission-control/cli build');
    }
    const sidecarBinary = resolveSidecarBinary(root);
    const releaseDir = join(root, 'dist/release');
    const stageDir = join(releaseDir, `mctrl-${platform.os}-${platform.arch}`);
    const artifactPath = join(releaseDir, artifactName);

    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    writeStagePackageManifest(stageDir);
    copyContainedDirectory(root, cliDistDir, stageDir);
    copyFileSync(cliEntry, join(stageDir, 'mc'));
    copyFileSync(cliEntry, join(stageDir, 'mctrl'));
    stageWorkspacePackages(root, stageDir);
    stageExternalPackages(root, stageDir, workspacePackages);
    copyFileSync(sidecarBinary, join(stageDir, 'mission-control-sidecar'));
    chmodSync(join(stageDir, 'mc'), 0o755);
    chmodSync(join(stageDir, 'mctrl'), 0o755);
    chmodSync(join(stageDir, 'mission-control-sidecar'), 0o755);

    const tar = spawnSync('tar', ['-czf', artifactPath, '-C', stageDir, '.'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    writeArtifactChecksum(artifactPath, artifactName);
    return artifactPath;
}

function writeArtifactChecksum(artifactPath: string, artifactName: string): void {
    const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    writeFileSync(`${artifactPath}.sha256`, `${digest}  ${artifactName}\n`);
}

function writeStagePackageManifest(stageDir: string): void {
    writeFileSync(
        join(stageDir, 'package.json'),
        `${JSON.stringify({ private: true, type: 'module', bin: { mc: './mc', mctrl: './mctrl' } }, null, 2)}\n`,
    );
}

function stageWorkspacePackages(root: string, stageDir: string): void {
    for (const packageInfo of workspacePackages) {
        const sourceRoot = join(root, packageInfo.source);
        const sourcePackageManifest = join(sourceRoot, 'package.json');
        const sourceDist = join(sourceRoot, 'dist');
        if (!existsSync(sourcePackageManifest)) throw new Error(`${packageInfo.source}/package.json missing`);
        if (!existsSync(sourceDist)) throw new Error(`${packageInfo.source}/dist missing; run pnpm build`);
        const destinationRoot = join(stageDir, 'node_modules', ...packageInfo.name.split('/'));
        mkdirSync(destinationRoot, { recursive: true });
        copyFileSync(sourcePackageManifest, join(destinationRoot, 'package.json'));
        copyContainedDirectory(root, sourceDist, join(destinationRoot, 'dist'));
    }
}

function normalizeOs(os: string): SupportedOs {
    if (os === 'linux' || os === 'darwin') return os;
    throw new Error(`unsupported OS: ${os}`);
}

function normalizeArch(arch: string): SupportedArch {
    if (arch === 'x64' || arch === 'arm64') return arch;
    throw new Error(`unsupported architecture: ${arch}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const artifactPath = createCurrentPlatformPackage();
        process.stdout.write(`created ${artifactPath}\n`);
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
