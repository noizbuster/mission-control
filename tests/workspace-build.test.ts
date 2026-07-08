import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nxRuntime = 'NX_DAEMON=false NX_ISOLATE_PLUGINS=false';

type PackageManifest = {
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly exports?: Record<string, string>;
    readonly private?: boolean;
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

        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(rootManifest.scripts?.['build']).toBe(`${nxRuntime} nx run-many -t build`);

        const buildablePackages: readonly PackageManifest[] = [
            protocolManifest,
            coreManifest,
            configManifest,
            cliManifest,
            desktopManifest,
        ];
        for (const manifest of buildablePackages) {
            // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
            expect(manifest.scripts?.['build']).toBeTruthy();
        }

        expectWorkspaceDependency(coreManifest, '@mission-control/protocol');
        expectWorkspaceDependency(cliManifest, '@mission-control/config');
        expectWorkspaceDependency(cliManifest, '@mission-control/core');
        expectWorkspaceDependency(cliManifest, '@mission-control/protocol');
        expectWorkspaceDependency(desktopManifest, '@mission-control/config');
        expectWorkspaceDependency(desktopManifest, '@mission-control/core');
        expectWorkspaceDependency(desktopManifest, '@mission-control/protocol');

        // Intentionally fails pre-split; passes once Todo 2 creates apps/tui.
        const tuiManifest = readManifest('apps/tui/package.json');
        for (const manifest of [...buildablePackages, tuiManifest]) {
            // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
            expect(manifest.scripts?.['build']).toBeTruthy();
        }
        expect(tuiManifest.private, 'tui must be private').toBe(true);
        expect(tuiManifest.dependencies?.['@opentui/solid'], 'tui must depend on OpenTUI Solid bindings').toBeTruthy();
        expect(tuiManifest.dependencies?.['solid-js'], 'tui must depend on Solid').toBeTruthy();
        expect(
            tuiManifest.dependencies?.['@opentui/react'],
            'tui must not depend on OpenTUI React bindings',
        ).toBeUndefined();
        expect(tuiManifest.exports?.['./terminal-viewport-solid'], 'tui must export the Solid viewport hook').toBe(
            './dist/platform/terminal-viewport-solid.js',
        );
        expect(
            tuiManifest.exports?.['./terminal-viewport-react'],
            'tui must not export the old viewport hook',
        ).toBeUndefined();
        expectWorkspaceDependency(cliManifest, '@mission-control/tui');
    });
});
