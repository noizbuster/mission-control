import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

type PackageManifest = {
    readonly name: string;
    readonly dependencies: Record<string, string>;
};

type PackageManifestCandidate = {
    readonly name?: unknown;
    readonly dependencies?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPackageManifestCandidate(value: unknown): value is PackageManifestCandidate {
    return typeof value === 'object' && value !== null;
}

function stringRecord(value: unknown): Record<string, string> {
    if (!isRecord(value)) {
        return {};
    }
    const entries: [string, string][] = [];
    for (const [key, entryValue] of Object.entries(value)) {
        if (typeof entryValue === 'string') {
            entries.push([key, entryValue]);
        }
    }
    return Object.fromEntries(entries);
}

function readPackageManifest(path: string): PackageManifest {
    const parsed: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (!isPackageManifestCandidate(parsed) || typeof parsed.name !== 'string') {
        throw new Error(`${path} is not a package manifest with a name`);
    }
    return {
        name: parsed.name,
        dependencies: stringRecord(parsed.dependencies),
    };
}

describe('@mission-control/tui Solid dependency contract', () => {
    it('reads and parses the TUI package manifest', () => {
        const manifest = readPackageManifest('apps/tui/package.json');

        expect(manifest.name).toBe('@mission-control/tui');
        expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0);
    });

    it('uses Solid OpenTUI dependencies after Todo 2 swaps the renderer binding', () => {
        const manifest = readPackageManifest('apps/tui/package.json');

        expect(manifest.dependencies['@opentui/react']).toBeUndefined();
        expect(manifest.dependencies['@opentui/solid']).toBeTruthy();
    });
});
