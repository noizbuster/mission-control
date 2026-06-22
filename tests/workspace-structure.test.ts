import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const requiredPackages = [
    {
        manifest: 'apps/cli/package.json',
        name: '@mission-control/cli',
    },
    {
        manifest: 'apps/desktop/package.json',
        name: '@mission-control/desktop',
    },
    {
        manifest: 'packages/core/package.json',
        name: '@mission-control/core',
    },
    {
        manifest: 'packages/protocol/package.json',
        name: '@mission-control/protocol',
    },
    {
        manifest: 'packages/config/package.json',
        name: '@mission-control/config',
    },
] as const;

const requiredRootScripts = ['test', 'typecheck', 'build', 'dev:cli', 'dev:sidecar', 'dev:desktop'] as const;

const requiredWorkflowDirectories = [
    'packages/core/src/workflows',
    'packages/core/src/persistence',
    'packages/core/src/permissions',
    'packages/core/src/runtime/mission-run',
    'packages/core/src/runtime/continuation',
    'packages/core/src/tools/task',
    'packages/core/src/tools/workflow-tool',
    'packages/core/src/tools/notepad-guard',
    'packages/core/src/behavior/modes',
    'packages/core/src/behavior/nodes',
] as const;

const requiredWorkflowFiles = [
    'examples/abg/default.workflow.json',
    'examples/abg/planner.workflow.json',
    'examples/abg/runner.workflow.json',
    'examples/abg/custom-example.workflow.jsonc',
    'examples/plans/example-plan.md',
    'docs/plugin-authoring.md',
] as const;

type PackageManifest = {
    readonly name?: string;
    readonly scripts?: Record<string, string>;
};

function readJson(path: string): PackageManifest {
    const parsed: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (!isPackageManifest(parsed)) {
        throw new Error(`${path} is not a package manifest`);
    }
    return parsed;
}

function isPackageManifest(value: unknown): value is PackageManifest {
    if (!isRecord(value)) {
        return false;
    }
    const name = value.name;
    const scripts = value.scripts;
    return (name === undefined || typeof name === 'string') && (scripts === undefined || isStringRecord(scripts));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) {
        return false;
    }
    return Object.values(value).every((item) => typeof item === 'string');
}

describe('workspace scaffold', () => {
    it('exposes required packages and scripts', () => {
        const rootManifest = readJson('package.json');

        for (const scriptName of requiredRootScripts) {
            expect(rootManifest.scripts?.[scriptName], `missing root script ${scriptName}`).toBeTruthy();
        }

        for (const pkg of requiredPackages) {
            const manifest = readJson(pkg.manifest);
            expect(manifest.name, `${pkg.manifest} package name`).toBe(pkg.name);
        }

        statSync(join(root, 'pnpm-workspace.yaml'));
        statSync(join(root, 'tsconfig.base.json'));
        statSync(join(root, 'README.md'));
    });

    it('exposes workflow system directories under packages/core', () => {
        for (const dir of requiredWorkflowDirectories) {
            const stats = statSync(join(root, dir));
            expect(stats.isDirectory(), `${dir} should be a directory`).toBe(true);
        }
    });

    it('exposes built-in workflow specs, example plan, and plugin authoring doc', () => {
        for (const file of requiredWorkflowFiles) {
            const stats = statSync(join(root, file));
            expect(stats.isFile(), `${file} should be a file`).toBe(true);
        }
    });
});
