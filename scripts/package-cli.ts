import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
] as const;

const externalPackages = ['zod'] as const;

export function detectPlatform(os = process.platform, arch = process.arch): PackagePlatform {
    return {
        os: normalizeOs(os),
        arch: normalizeArch(arch),
    };
}

export function getArtifactName(platform: PackagePlatform): string {
    return `mctrl-${platform.os}-${platform.arch}.tar.gz`;
}

export function resolveSidecarBinary(root: string): string {
    const releaseBinary = join(root, 'native/sidecar/target/release/mission-control-sidecar');
    const debugBinary = join(root, 'native/sidecar/target/debug/mission-control-sidecar');
    if (existsSync(releaseBinary)) {
        return releaseBinary;
    }
    if (existsSync(debugBinary)) {
        return debugBinary;
    }
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
    cpSync(cliDistDir, stageDir, { recursive: true });
    copyFileSync(cliEntry, join(stageDir, 'mctrl'));
    stageWorkspacePackages(root, stageDir);
    stageExternalPackages(root, stageDir);
    copyFileSync(sidecarBinary, join(stageDir, 'mission-control-sidecar'));
    chmodSync(join(stageDir, 'mctrl'), 0o755);
    chmodSync(join(stageDir, 'mission-control-sidecar'), 0o755);

    const tar = spawnSync('tar', ['-czf', artifactPath, '-C', stageDir, '.'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.status !== 0) {
        throw new Error(`tar failed: ${tar.stderr}`);
    }

    return artifactPath;
}

function writeStagePackageManifest(stageDir: string): void {
    writeFileSync(
        join(stageDir, 'package.json'),
        `${JSON.stringify({ private: true, type: 'module', bin: { mctrl: './mctrl' } }, null, 2)}\n`,
    );
}

function stageWorkspacePackages(root: string, stageDir: string): void {
    for (const packageInfo of workspacePackages) {
        const sourceRoot = join(root, packageInfo.source);
        const sourcePackageManifest = join(sourceRoot, 'package.json');
        const sourceDist = join(sourceRoot, 'dist');
        if (!existsSync(sourcePackageManifest)) {
            throw new Error(`${packageInfo.source}/package.json missing`);
        }
        if (!existsSync(sourceDist)) {
            throw new Error(`${packageInfo.source}/dist missing; run pnpm build`);
        }
        const destinationRoot = join(stageDir, 'node_modules', ...packageInfo.name.split('/'));
        mkdirSync(destinationRoot, { recursive: true });
        copyFileSync(sourcePackageManifest, join(destinationRoot, 'package.json'));
        cpSync(sourceDist, join(destinationRoot, 'dist'), { recursive: true });
    }
}

function stageExternalPackages(root: string, stageDir: string): void {
    for (const packageName of externalPackages) {
        const sourceRoot = resolveExternalPackageRoot(root, packageName);
        cpSync(sourceRoot, join(stageDir, 'node_modules', ...packageName.split('/')), {
            dereference: true,
            recursive: true,
        });
    }
}

function resolveExternalPackageRoot(root: string, packageName: string): string {
    const packagePathParts = packageName.split('/');
    const candidateRoots = [
        join(root, 'node_modules', ...packagePathParts),
        join(root, 'node_modules/.pnpm/node_modules', ...packagePathParts),
        ...workspacePackages.map((packageInfo) => join(root, packageInfo.source, 'node_modules', ...packagePathParts)),
    ];
    const packageRoot = candidateRoots.find((candidate) => existsSync(candidate));
    if (packageRoot === undefined) {
        throw new Error(`${packageName} dependency missing; run pnpm install`);
    }
    return packageRoot;
}

function normalizeOs(os: string): SupportedOs {
    switch (os) {
        case 'linux':
            return 'linux';
        case 'darwin':
            return 'darwin';
        default:
            throw new Error(`unsupported OS: ${os}`);
    }
}

function normalizeArch(arch: string): SupportedArch {
    switch (arch) {
        case 'x64':
            return 'x64';
        case 'arm64':
            return 'arm64';
        default:
            throw new Error(`unsupported architecture: ${arch}`);
    }
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
