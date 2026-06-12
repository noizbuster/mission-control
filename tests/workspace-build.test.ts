import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nxRuntime = 'NX_DAEMON=false NX_ISOLATE_PLUGINS=false';

type PackageManifest = {
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
};

function readManifest(path: string): PackageManifest {
    const parsed: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (!isManifest(parsed)) {
        throw new Error(`${path} is not a package manifest`);
    }
    return parsed;
}

function isManifest(value: unknown): value is PackageManifest {
    return typeof value === 'object' && value !== null;
}

function expectWorkspaceDependency(manifest: PackageManifest, dependencyName: string): void {
    expect(manifest.dependencies?.[dependencyName], `missing workspace dependency ${dependencyName}`).toBe(
        'workspace:*',
    );
}

describe('workspace build integration', () => {
    it('declares an Nx build script and buildable package graph', () => {
        const rootManifest = readManifest('package.json');
        const protocolManifest = readManifest('packages/protocol/package.json');
        const coreManifest = readManifest('packages/core/package.json');
        const configManifest = readManifest('packages/config/package.json');
        const cliManifest = readManifest('apps/cli/package.json');
        const desktopManifest = readManifest('apps/desktop/package.json');

        expect(rootManifest.scripts?.['build']).toBe(`${nxRuntime} nx run-many -t build`);

        for (const manifest of [protocolManifest, coreManifest, configManifest, cliManifest, desktopManifest]) {
            expect(manifest.scripts?.['build']).toBeTruthy();
        }

        expectWorkspaceDependency(coreManifest, '@mission-control/protocol');
        expectWorkspaceDependency(cliManifest, '@mission-control/config');
        expectWorkspaceDependency(cliManifest, '@mission-control/core');
        expectWorkspaceDependency(cliManifest, '@mission-control/protocol');
        expectWorkspaceDependency(desktopManifest, '@mission-control/config');
        expectWorkspaceDependency(desktopManifest, '@mission-control/core');
        expectWorkspaceDependency(desktopManifest, '@mission-control/protocol');
    });
});
