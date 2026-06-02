import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nxRuntime = 'NX_DAEMON=false NX_ISOLATE_PLUGINS=false';

const requiredProjects = [
    {
        name: 'workspace',
        path: 'project.json',
        targets: ['build', 'lint', 'test', 'typecheck', 'package-cli'],
    },
    {
        name: 'cli',
        path: 'apps/cli/project.json',
        targets: ['build', 'dev', 'test', 'typecheck'],
    },
    {
        name: 'desktop',
        path: 'apps/desktop/project.json',
        targets: ['build', 'dev', 'test', 'typecheck', 'tauri-test'],
    },
    {
        name: 'protocol',
        path: 'packages/protocol/project.json',
        targets: ['build', 'test', 'typecheck'],
    },
    {
        name: 'core',
        path: 'packages/core/project.json',
        targets: ['build', 'test', 'typecheck'],
    },
    {
        name: 'config',
        path: 'packages/config/project.json',
        targets: ['build', 'test', 'typecheck'],
    },
    {
        name: 'sidecar',
        path: 'native/sidecar/project.json',
        targets: ['build', 'dev', 'test'],
    },
] as const;

type JsonObject = Record<string, unknown>;

type RootManifest = {
    readonly scripts?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
};

type NxConfig = {
    readonly namedInputs?: JsonObject;
    readonly targetDefaults?: JsonObject;
};

type ProjectConfig = {
    readonly name?: string;
    readonly targets?: JsonObject;
    readonly implicitDependencies?: readonly string[];
};

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function readRootManifest(): RootManifest {
    const parsed = readJson('package.json');
    if (!isRootManifest(parsed)) {
        throw new Error('package.json is not a root manifest');
    }
    return parsed;
}

function readNxConfig(): NxConfig {
    const parsed = readJson('nx.json');
    if (!isNxConfig(parsed)) {
        throw new Error('nx.json is not an Nx config');
    }
    return parsed;
}

function readProjectConfig(path: string): ProjectConfig {
    const parsed = readJson(path);
    if (!isProjectConfig(parsed)) {
        throw new Error(`${path} is not an Nx project config`);
    }
    return parsed;
}

function isRootManifest(value: unknown): value is RootManifest {
    if (!isRecord(value)) {
        return false;
    }
    const scripts = value['scripts'];
    const devDependencies = value['devDependencies'];
    return (
        (scripts === undefined || isStringRecord(scripts)) &&
        (devDependencies === undefined || isStringRecord(devDependencies))
    );
}

function isNxConfig(value: unknown): value is NxConfig {
    if (!isRecord(value)) {
        return false;
    }
    const namedInputs = value['namedInputs'];
    const targetDefaults = value['targetDefaults'];
    return (
        (namedInputs === undefined || isRecord(namedInputs)) &&
        (targetDefaults === undefined || isRecord(targetDefaults))
    );
}

function isProjectConfig(value: unknown): value is ProjectConfig {
    if (!isRecord(value)) {
        return false;
    }
    const name = value['name'];
    const targets = value['targets'];
    const implicitDependencies = value['implicitDependencies'];
    return (
        (name === undefined || typeof name === 'string') &&
        (targets === undefined || isRecord(targets)) &&
        (implicitDependencies === undefined || isStringArray(implicitDependencies))
    );
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) {
        return false;
    }
    return Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

describe('Nx workspace', () => {
    it('routes root scripts through Nx', () => {
        const manifest = readRootManifest();

        expect(manifest.devDependencies?.['nx']).toBeTruthy();
        expect(manifest.scripts?.['build']).toBe(`${nxRuntime} nx run-many -t build`);
        expect(manifest.scripts?.['typecheck']).toBe(`${nxRuntime} nx run-many -t typecheck`);
        expect(manifest.scripts?.['test']).toBe(`${nxRuntime} nx run-many -t test`);
        expect(manifest.scripts?.['lint']).toBe(`${nxRuntime} nx run workspace:lint`);
        expect(manifest.scripts?.['dev:cli']).toBe(`${nxRuntime} nx run cli:dev --`);
        expect(manifest.scripts?.['dev:desktop']).toBe(`${nxRuntime} nx run desktop:dev`);
        expect(manifest.scripts?.['dev:sidecar']).toBe(`${nxRuntime} nx run sidecar:dev --`);
        expect(manifest.scripts?.['dev:package-cli']).toBe(`${nxRuntime} nx run workspace:package-cli`);
    });

    it('declares cacheable Nx target defaults', () => {
        const config = readNxConfig();

        expect(config.namedInputs?.['default']).toBeTruthy();
        expect(config.namedInputs?.['production']).toBeTruthy();
        expect(config.targetDefaults?.['build']).toMatchObject({ cache: true });
        expect(config.targetDefaults?.['test']).toMatchObject({ cache: true });
        expect(config.targetDefaults?.['typecheck']).toMatchObject({ cache: true });
        expect(config.targetDefaults?.['lint']).toMatchObject({ cache: true });
    });

    it('defines Nx projects for every workspace boundary', () => {
        for (const project of requiredProjects) {
            expect(existsSync(join(root, project.path)), `${project.path} exists`).toBe(true);

            const config = readProjectConfig(project.path);
            expect(config.name, `${project.path} name`).toBe(project.name);

            for (const target of project.targets) {
                expect(config.targets?.[target], `${project.name}:${target} target`).toBeTruthy();
            }
        }

        expect(readProjectConfig('packages/core/project.json').implicitDependencies).toContain('protocol');
        expect(readProjectConfig('apps/cli/project.json').implicitDependencies).toEqual(['config', 'core', 'protocol']);
        expect(readProjectConfig('apps/desktop/project.json').implicitDependencies).toEqual(['config', 'protocol']);
    });
});
