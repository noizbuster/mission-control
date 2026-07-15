import { readFileSync } from 'node:fs';

export type PackageManifest = {
    readonly version?: string;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly optionalDependencies: Readonly<Record<string, string>>;
    readonly peerDependencies: Readonly<Record<string, string>>;
};

export function readPackageManifest(path: string): PackageManifest {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return emptyPackageManifest();
    }
    const record = parsed as {
        readonly version?: unknown;
        readonly dependencies?: unknown;
        readonly optionalDependencies?: unknown;
        readonly peerDependencies?: unknown;
    };
    return {
        ...(typeof record.version === 'string' ? { version: record.version } : {}),
        dependencies: readDependencyMap(record.dependencies),
        optionalDependencies: readDependencyMap(record.optionalDependencies),
        peerDependencies: readDependencyMap(record.peerDependencies),
    };
}

function emptyPackageManifest(): PackageManifest {
    return { dependencies: {}, optionalDependencies: {}, peerDependencies: {} };
}

function readDependencyMap(value: unknown): Readonly<Record<string, string>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const dependencies: Record<string, string> = {};
    for (const [name, version] of Object.entries(value)) {
        if (typeof version === 'string') dependencies[name] = version;
    }
    return dependencies;
}
