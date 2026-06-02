import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

type SupportedOs = 'linux' | 'darwin';
type SupportedArch = 'x64' | 'arm64';

type PackagePlatform = {
    readonly os: SupportedOs;
    readonly arch: SupportedArch;
};

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
    const cliEntry = join(root, 'apps/cli/dist/index.js');
    if (!existsSync(cliEntry)) {
        throw new Error('apps/cli/dist/index.js missing; run pnpm --filter @mission-control/cli build');
    }
    const sidecarBinary = resolveSidecarBinary(root);
    const releaseDir = join(root, 'dist/release');
    const stageDir = join(releaseDir, `mctrl-${platform.os}-${platform.arch}`);
    const artifactPath = join(releaseDir, artifactName);

    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    copyFileSync(cliEntry, join(stageDir, 'mctrl'));
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
