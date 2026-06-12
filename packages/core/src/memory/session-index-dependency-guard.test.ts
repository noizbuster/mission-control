import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SQLITE_NODE_DEPENDENCIES = ['better-sqlite3', 'sqlite3', 'sql.js'] as const;
const SQLITE_RUST_DEPENDENCIES = ['rusqlite', 'libsql'] as const;
const SKIPPED_DIRS = new Set(['.git', '.nx', '.omo', 'dist', 'node_modules', 'target', 'temp']);

const PackageManifestSchema = z
    .object({
        dependencies: z.record(z.string(), z.unknown()).optional(),
        devDependencies: z.record(z.string(), z.unknown()).optional(),
        optionalDependencies: z.record(z.string(), z.unknown()).optional(),
        peerDependencies: z.record(z.string(), z.unknown()).optional(),
    })
    .catchall(z.unknown());

describe('session index dependency guard', () => {
    it('does not add an unauthorized SQLite dependency', async () => {
        // Given: this wave only approves a schema-ready boundary, not a SQLite adapter dependency.
        const root = process.cwd();
        const manifests = await collectManifestPaths(root);

        // When: package and Rust manifests are inspected.
        const nodeManifests = manifests.filter((manifest) => basename(manifest) === 'package.json');
        const cargoManifests = manifests.filter((manifest) => basename(manifest) === 'Cargo.toml');
        const lockfiles = manifests.filter((manifest) => basename(manifest) === 'pnpm-lock.yaml');

        // Then: no forbidden SQLite package or crate is present.
        const nodeDependencySet = new Set<string>(SQLITE_NODE_DEPENDENCIES);
        const forbiddenNodeDependencies = (await nodeDependencyNames(nodeManifests)).filter((dependency) =>
            nodeDependencySet.has(dependency),
        );
        expect(forbiddenNodeDependencies).toEqual([]);
        await expect(textMatches(cargoManifests, cargoDependencyPattern(SQLITE_RUST_DEPENDENCIES))).resolves.toEqual(
            [],
        );
        await expect(textMatches(lockfiles, pnpmLockPattern(SQLITE_NODE_DEPENDENCIES))).resolves.toEqual([]);
    });
});

async function collectManifestPaths(root: string): Promise<readonly string[]> {
    const found: string[] = [];
    await collectManifestPathsInto(root, found);
    return found;
}

async function collectManifestPathsInto(dir: string, found: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) {
                await collectManifestPathsInto(join(dir, entry.name), found);
            }
            continue;
        }
        if (isManifest(entry.name)) {
            found.push(join(dir, entry.name));
        }
    }
}

function isManifest(name: string): boolean {
    return name === 'package.json' || name === 'Cargo.toml' || name === 'pnpm-lock.yaml';
}

async function nodeDependencyNames(paths: readonly string[]): Promise<readonly string[]> {
    const names = new Set<string>();
    for (const path of paths) {
        const manifest = PackageManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        for (const section of dependencySections(manifest)) {
            for (const name of Object.keys(section)) {
                names.add(name);
            }
        }
    }
    return [...names].sort();
}

function dependencySections(manifest: z.infer<typeof PackageManifestSchema>): readonly Record<string, unknown>[] {
    return [
        manifest.dependencies ?? {},
        manifest.devDependencies ?? {},
        manifest.optionalDependencies ?? {},
        manifest.peerDependencies ?? {},
    ];
}

async function textMatches(paths: readonly string[], pattern: RegExp): Promise<readonly string[]> {
    const matches: string[] = [];
    for (const path of paths) {
        const contents = await readFile(path, 'utf8');
        if (pattern.test(contents)) {
            matches.push(path);
        }
    }
    return matches;
}

function cargoDependencyPattern(names: readonly string[]): RegExp {
    return new RegExp(`(^|\\n)\\s*(${names.map(escapeRegExp).join('|')})\\s*=`, 'u');
}

function pnpmLockPattern(names: readonly string[]): RegExp {
    return new RegExp(
        `(^|\\n)\\s*(/${names.map(escapeRegExp).join('@|/')}@|${names.map(escapeRegExp).join('|')}:)`,
        'u',
    );
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
