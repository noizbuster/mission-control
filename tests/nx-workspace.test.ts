import { describe, expect, it } from 'vitest';
import {
    readNxConfig,
    readProjectConfig,
    readRootManifest,
    readTargetCommand,
    readTargetCwd,
    readTuiManifest,
} from './nx-workspace-test-support';
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
    {
        name: 'natives',
        path: 'native/natives/project.json',
        targets: ['build', 'test'],
    },
    {
        name: 'tui',
        path: 'apps/tui/project.json',
        targets: ['build', 'test', 'typecheck'],
    },
] as const;

describe('Nx workspace', () => {
    it('routes root scripts through Nx', () => {
        const manifest = readRootManifest();

        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(manifest.devDependencies?.['nx']).toBeTruthy();
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(manifest.scripts?.['build']).toBe(`${nxRuntime} nx run-many -t build`);
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(manifest.scripts?.['typecheck']).toBe(`${nxRuntime} nx run-many -t typecheck`);
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(manifest.scripts?.['test']).toBe(`${nxRuntime} nx run-many -t test --parallel=1`);
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, string> requires bracket access per noPropertyAccessFromIndexSignature
        expect(manifest.scripts?.['lint']).toBe(`${nxRuntime} nx run workspace:lint`);
        // Interactive TUI must not run under the Nx process wrapper (SIGWINCH/resize).
        expect(manifest.scripts?.['dev:cli']).toBe('pnpm --filter @mission-control/cli dev');
        expect(manifest.scripts?.['dev:desktop']).toBe(`${nxRuntime} nx run desktop:dev`);
        expect(manifest.scripts?.['dev:sidecar']).toBe(`${nxRuntime} nx run sidecar:dev --`);
        expect(manifest.scripts?.['dev:package-cli']).toBe(`${nxRuntime} nx run workspace:package-cli`);
    });

    it('declares cacheable Nx target defaults', () => {
        const config = readNxConfig();

        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.namedInputs?.['default']).toBeTruthy();
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.namedInputs?.['production']).toBeTruthy();
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.targetDefaults?.['build']).toMatchObject({ cache: true });
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.targetDefaults?.['test']).toMatchObject({ cache: true });
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.targetDefaults?.['test']).toMatchObject({ inputs: expect.arrayContaining(['workflowParity']) });
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.targetDefaults?.['typecheck']).toMatchObject({ cache: true });
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.targetDefaults?.['lint']).toMatchObject({ cache: true });
    });

    it('lints every maintained workspace root without traversing reference checkouts', () => {
        const config = readProjectConfig('project.json');

        expect(readTargetCommand(config, 'lint')).toBe(
            'biome lint apps docs examples native packages scripts tests package.json project.json nx.json tsconfig.base.json vitest.config.ts biome.jsonc biome.usd.jsonc skills-lock.json',
        );
    });

    it('builds the CLI dependency graph before workspace tests and typechecking', () => {
        // Given: workspace verification imports built package declarations and executes built-CLI suites.
        const config = readProjectConfig('project.json');

        // When: Nx resolves the workspace verification targets.
        const testTarget = config.targets === undefined ? undefined : Reflect.get(config.targets, 'test');
        const typecheckTarget = config.targets === undefined ? undefined : Reflect.get(config.targets, 'typecheck');

        // Then: the precise CLI build and its canonical dependency builds complete first.
        expect(typecheckTarget).toMatchObject({ dependsOn: [{ projects: ['cli'], target: 'build' }] });
        expect(testTarget).toMatchObject({
            dependsOn: [{ projects: ['cli'], target: 'build' }],
            inputs: expect.arrayContaining([
                '{workspaceRoot}/tests/**/*',
                '{workspaceRoot}/scripts/**/*',
                '{workspaceRoot}/.github/workflows/**/*',
                'workflowParity',
                '{workspaceRoot}/README.md',
                '{workspaceRoot}/project.json',
                '{workspaceRoot}/nx.json',
                '{workspaceRoot}/apps/cli/project.json',
            ]),
        });
    });

    it('hashes every built-in workflow fixture into parity test caches', () => {
        const config = readNxConfig();

        // biome-ignore lint/complexity/useLiteralKeys: JsonObject (Record<string, unknown>) requires bracket access per noPropertyAccessFromIndexSignature
        expect(config.namedInputs?.['workflowParity']).toEqual(
            expect.arrayContaining([
                '{workspaceRoot}/examples/abg/default.workflow.json',
                '{workspaceRoot}/examples/abg/planner.workflow.json',
                '{workspaceRoot}/examples/abg/executer.workflow.json',
                '{workspaceRoot}/examples/abg/custom-example.workflow.jsonc',
                '{workspaceRoot}/ABG.md',
                '{workspaceRoot}/docs/abg-reference-parity-matrix.md',
            ]),
        );
    });

    it('keeps the built-CLI workspace helper free of nested Nx builds', () => {
        // Given: both built-CLI suites share the same support module.
        const support = readFileSync(join(root, 'tests/cli-local-db-concurrency-support.ts'), 'utf8');

        // When: the helper source is inspected as part of the workspace contract.
        // Then: it resolves a prebuilt artifact instead of launching another task runner.
        expect(support).toContain('resolveBuiltCliEntryPath');
        expect(support).not.toContain("['exec', 'nx', 'run', 'cli:build'");
    });

    it('keeps the TUI-to-CLI boundary scan unconditional', () => {
        const boundary = readFileSync(join(root, 'tests/tui-cli-boundary.test.ts'), 'utf8');

        expect(boundary).not.toMatch(/it\.skip|skipIf/u);
        expect(boundary).not.toContain('not yet created');
    });

    it('runs TUI tests from the package with native FFI enabled by Vitest', () => {
        // Given: the TUI package and Nx target are the two default test entrypoints.
        const project = readProjectConfig('apps/tui/project.json');
        const viteConfig = readFileSync(join(root, 'apps/tui/vite.config.ts'), 'utf8');

        // When: either default entrypoint is inspected.
        // Then: both use the shell-free package command from the workspace root and shared Vitest FFI config.
        expect(readTuiManifest().scripts?.test).toBe(
            'pnpm --dir ../.. exec vitest run --config apps/tui/vite.config.ts apps/tui/src --reporter verbose',
        );
        expect(readTargetCwd(project, 'test')).toBe('apps/tui');
        expect(readTargetCommand(project, 'test')).toBe('pnpm test');
        expect(viteConfig).toContain("environment: 'node'");
        expect(viteConfig).toContain("execArgv: ['--experimental-ffi']");
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
        expect(readProjectConfig('apps/cli/project.json').implicitDependencies).toEqual([
            'config',
            'core',
            'protocol',
            'tui',
        ]);
        expect(readProjectConfig('apps/desktop/project.json').implicitDependencies).toEqual([
            'config',
            'core',
            'protocol',
        ]);
    });

    it('keeps root Vitest TUI subpath aliases on Solid viewport naming', () => {
        const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');

        expect(config).not.toContain('@mission-control/tui/terminal-viewport-react');
        expect(config).not.toContain('platform/terminal-viewport-react.ts');
    });
});
