import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

const workspacePackageNames = new Set<string>(workspacePackages.map((packageInfo) => packageInfo.name));

type PackageManifest = {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly optionalDependencies: Readonly<Record<string, string>>;
    readonly peerDependencies: Readonly<Record<string, string>>;
};

type DependencyRequest = {
    readonly name: string;
    readonly required: boolean;
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
    copyFileSync(cliEntry, join(stageDir, 'mc'));
    copyFileSync(cliEntry, join(stageDir, 'mctrl'));
    stageWorkspacePackages(root, stageDir);
    stageExternalPackages(root, stageDir);
    copyFileSync(sidecarBinary, join(stageDir, 'mission-control-sidecar'));
    chmodSync(join(stageDir, 'mc'), 0o755);
    chmodSync(join(stageDir, 'mctrl'), 0o755);
    chmodSync(join(stageDir, 'mission-control-sidecar'), 0o755);

    const tar = spawnSync('tar', ['-czf', artifactPath, '-C', stageDir, '.'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.status !== 0) {
        throw new Error(`tar failed: ${tar.stderr}`);
    }
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
    const staged = new Set<string>();
    for (const dependency of collectRuntimeExternalDependencies(root)) {
        stageExternalPackage(root, stageDir, dependency, staged);
    }
}

function collectRuntimeExternalDependencies(root: string): readonly DependencyRequest[] {
    const manifestPaths = [
        join(root, 'apps/cli/package.json'),
        ...workspacePackages.map((packageInfo) => join(root, packageInfo.source, 'package.json')),
    ];
    const dependencies = new Map<string, boolean>();
    for (const manifestPath of manifestPaths) {
        if (!existsSync(manifestPath)) {
            continue;
        }
        for (const dependency of dependencyRequestsFromManifest(readPackageManifest(manifestPath))) {
            if (workspacePackageNames.has(dependency.name)) {
                continue;
            }
            dependencies.set(dependency.name, (dependencies.get(dependency.name) ?? false) || dependency.required);
        }
    }
    return [...dependencies.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, required]) => ({ name, required }));
}

function stageExternalPackage(
    root: string,
    stageDir: string,
    dependency: DependencyRequest,
    staged: Set<string>,
    fromPackageRoot?: string,
): void {
    if (staged.has(dependency.name)) {
        return;
    }
    const sourceRoot = findExternalPackageRoot(root, dependency.name, fromPackageRoot);
    if (sourceRoot === undefined) {
        if (dependency.required) {
            throw new Error(`${dependency.name} dependency missing; run pnpm install`);
        }
        return;
    }

    staged.add(dependency.name);
    const destinationRoot = join(stageDir, 'node_modules', ...dependency.name.split('/'));
    mkdirSync(dirname(destinationRoot), { recursive: true });
    cpSync(sourceRoot, destinationRoot, { dereference: true, recursive: true });

    const manifestPath = join(sourceRoot, 'package.json');
    if (!existsSync(manifestPath)) {
        return;
    }
    for (const childDependency of dependencyRequestsFromManifest(readPackageManifest(manifestPath))) {
        if (workspacePackageNames.has(childDependency.name)) {
            continue;
        }
        stageExternalPackage(root, stageDir, childDependency, staged, sourceRoot);
    }
}

function findExternalPackageRoot(root: string, packageName: string, fromPackageRoot?: string): string | undefined {
    const packagePathParts = packageName.split('/');
    const fromNodeModules = fromPackageRoot === undefined ? undefined : findNearestNodeModules(fromPackageRoot);
    const candidateRoots = [
        ...(fromNodeModules === undefined ? [] : [join(fromNodeModules, ...packagePathParts)]),
        join(root, 'node_modules', ...packagePathParts),
        join(root, 'node_modules/.pnpm/node_modules', ...packagePathParts),
        ...workspacePackages.map((packageInfo) => join(root, packageInfo.source, 'node_modules', ...packagePathParts)),
    ];
    return candidateRoots.find((candidate) => candidate.length > 0 && existsSync(candidate));
}

function findNearestNodeModules(path: string): string | undefined {
    let current = path;
    for (;;) {
        if (basename(current) === 'node_modules') {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function dependencyRequestsFromManifest(manifest: PackageManifest): readonly DependencyRequest[] {
    return [
        ...Object.keys(manifest.dependencies).map((name) => ({ name, required: true })),
        ...Object.keys(manifest.optionalDependencies).map((name) => ({ name, required: false })),
        ...Object.keys(manifest.peerDependencies).map((name) => ({ name, required: false })),
    ];
}

function readPackageManifest(path: string): PackageManifest {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return emptyPackageManifest();
    }
    const record = parsed as {
        readonly dependencies?: unknown;
        readonly optionalDependencies?: unknown;
        readonly peerDependencies?: unknown;
    };
    return {
        dependencies: readDependencyMap(record.dependencies),
        optionalDependencies: readDependencyMap(record.optionalDependencies),
        peerDependencies: readDependencyMap(record.peerDependencies),
    };
}

function emptyPackageManifest(): PackageManifest {
    return {
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
    };
}

function readDependencyMap(value: unknown): Readonly<Record<string, string>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }
    const dependencies: Record<string, string> = {};
    for (const [name, version] of Object.entries(value)) {
        if (typeof version === 'string') {
            dependencies[name] = version;
        }
    }
    return dependencies;
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
