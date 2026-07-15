import { assertContainedPath, copyExternalPackageDirectory, packageDestination } from './package-cli-files.ts';
import { type PackageManifest, readPackageManifest } from './package-cli-manifest.ts';
import { assertPackageVersion } from './package-cli-semver.ts';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type WorkspacePackageInfo = {
    readonly name: string;
    readonly source: string;
};

type DependencyRequest = {
    readonly name: string;
    readonly specifier: string;
    readonly required: boolean;
    readonly fromPackageRoot?: string;
};

type ExternalStageContext = {
    readonly root: string;
    readonly stageDir: string;
    readonly workspacePackages: readonly WorkspacePackageInfo[];
    readonly workspacePackageNames: ReadonlySet<string>;
    readonly stagedSources: Map<string, string>;
    readonly expandedDestinations: Set<string>;
    readonly flatSources: Map<string, string>;
};

export function stageExternalPackages(
    root: string,
    stageDir: string,
    workspacePackages: readonly WorkspacePackageInfo[],
): void {
    const context: ExternalStageContext = {
        root,
        stageDir,
        workspacePackages,
        workspacePackageNames: new Set(workspacePackages.map((packageInfo) => packageInfo.name)),
        stagedSources: new Map(),
        expandedDestinations: new Set(),
        flatSources: new Map(),
    };
    const directPackages: { readonly sourceRoot: string; readonly destinationRoot: string }[] = [];
    for (const dependency of collectRuntimeExternalDependencies(context)) {
        const sourceRoot = resolveDependencySource(context, dependency, dependency.fromPackageRoot);
        if (sourceRoot === undefined) continue;
        const destinationRoot = packageDestination(join(stageDir, 'node_modules'), dependency.name, stageDir);
        context.flatSources.set(dependency.name, sourceRoot);
        copyExternalPackage(context, sourceRoot, destinationRoot, dependency.name);
        directPackages.push({ sourceRoot, destinationRoot });
    }
    for (const packageInfo of directPackages) {
        stageExternalDependencies(context, packageInfo.sourceRoot, packageInfo.destinationRoot, new Set());
    }
}

function collectRuntimeExternalDependencies(context: ExternalStageContext): readonly DependencyRequest[] {
    const manifestPaths = [
        join(context.root, 'apps/cli/package.json'),
        ...context.workspacePackages.map((packageInfo) => join(context.root, packageInfo.source, 'package.json')),
    ];
    const dependencies = new Map<string, DependencyRequest>();
    for (const manifestPath of manifestPaths) {
        if (!existsSync(manifestPath)) continue;
        for (const dependency of dependencyRequestsFromManifest(
            readPackageManifest(manifestPath),
            dirname(manifestPath),
        )) {
            if (context.workspacePackageNames.has(dependency.name)) continue;
            const existing = dependencies.get(dependency.name);
            if (existing === undefined || (!existing.required && dependency.required)) {
                dependencies.set(dependency.name, dependency);
            }
        }
    }
    return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function stageExternalDependencies(
    context: ExternalStageContext,
    sourceRoot: string,
    destinationRoot: string,
    ancestors: ReadonlySet<string>,
): void {
    if (context.expandedDestinations.has(destinationRoot)) return;
    context.expandedDestinations.add(destinationRoot);
    const manifestPath = join(sourceRoot, 'package.json');
    if (!existsSync(manifestPath)) return;
    const childAncestors = new Set(ancestors);
    childAncestors.add(sourceRoot);
    for (const dependency of dependencyRequestsFromManifest(readPackageManifest(manifestPath))) {
        if (context.workspacePackageNames.has(dependency.name)) continue;
        const childSourceRoot = resolveDependencySource(context, dependency, sourceRoot);
        if (childSourceRoot === undefined || childAncestors.has(childSourceRoot)) continue;
        const flatSourceRoot = context.flatSources.get(dependency.name);
        const childDestinationRoot =
            flatSourceRoot === undefined || flatSourceRoot === childSourceRoot
                ? packageDestination(join(context.stageDir, 'node_modules'), dependency.name, context.stageDir)
                : packageDestination(join(destinationRoot, 'node_modules'), dependency.name, context.stageDir);
        if (flatSourceRoot === undefined) context.flatSources.set(dependency.name, childSourceRoot);
        copyExternalPackage(context, childSourceRoot, childDestinationRoot, dependency.name);
        stageExternalDependencies(context, childSourceRoot, childDestinationRoot, childAncestors);
    }
}

function resolveDependencySource(
    context: ExternalStageContext,
    dependency: DependencyRequest,
    fromPackageRoot?: string,
): string | undefined {
    assertPackageName(dependency.name);
    const sourceRoot = findExternalPackageRoot(context, dependency.name, fromPackageRoot);
    if (sourceRoot === undefined) {
        if (dependency.required) throw new Error(`${dependency.name} dependency missing; run pnpm install`);
        return undefined;
    }
    const canonicalSourceRoot = realpathSync(sourceRoot);
    assertContainedPath(realpathSync(context.root), canonicalSourceRoot, `source for ${dependency.name}`);
    assertPackageVersion(
        dependency.name,
        dependency.specifier,
        readPackageManifest(join(canonicalSourceRoot, 'package.json')).version,
    );
    return canonicalSourceRoot;
}

function copyExternalPackage(
    context: ExternalStageContext,
    sourceRoot: string,
    destinationRoot: string,
    packageName: string,
): void {
    const stagedSource = context.stagedSources.get(destinationRoot);
    if (stagedSource !== undefined) {
        if (stagedSource !== sourceRoot) throw new Error(`dependency version collision for ${packageName}`);
        return;
    }
    context.stagedSources.set(destinationRoot, sourceRoot);
    mkdirSync(dirname(destinationRoot), { recursive: true });
    copyExternalPackageDirectory(context.root, sourceRoot, destinationRoot);
}

function assertPackageName(packageName: string): void {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
        throw new Error(`invalid dependency package name: ${packageName}`);
    }
}

function findExternalPackageRoot(
    context: ExternalStageContext,
    packageName: string,
    fromPackageRoot?: string,
): string | undefined {
    const packagePathParts = packageName.split('/');
    const fromNodeModules = fromPackageRoot === undefined ? undefined : findNearestNodeModules(fromPackageRoot);
    const candidateRoots = [
        ...(fromPackageRoot === undefined ? [] : [join(fromPackageRoot, 'node_modules', ...packagePathParts)]),
        ...(fromNodeModules === undefined ? [] : [join(fromNodeModules, ...packagePathParts)]),
        join(context.root, 'node_modules', ...packagePathParts),
        join(context.root, 'node_modules/.pnpm/node_modules', ...packagePathParts),
        ...context.workspacePackages.map((packageInfo) =>
            join(context.root, packageInfo.source, 'node_modules', ...packagePathParts),
        ),
    ];
    return candidateRoots.find((candidate) => candidate.length > 0 && existsSync(candidate));
}

function findNearestNodeModules(path: string): string | undefined {
    let current = path;
    for (;;) {
        if (basename(current) === 'node_modules') return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function dependencyRequestsFromManifest(
    manifest: PackageManifest,
    fromPackageRoot?: string,
): readonly DependencyRequest[] {
    return [
        ...Object.entries(manifest.dependencies).map(([name, specifier]) => ({
            name,
            specifier,
            required: true,
            ...(fromPackageRoot !== undefined ? { fromPackageRoot } : {}),
        })),
        ...Object.entries(manifest.optionalDependencies).map(([name, specifier]) => ({
            name,
            specifier,
            required: false,
            ...(fromPackageRoot !== undefined ? { fromPackageRoot } : {}),
        })),
    ];
}
