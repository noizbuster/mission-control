import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const productSourceRoots = ['apps', 'packages'] as const;
const tuiSourceRoot = 'apps/tui/src';
const stateSourceRoot = 'apps/tui/src/state';
const indexSourcePath = 'apps/tui/src/index.ts';
const platformProvidersRoot = 'apps/tui/src/platform/providers';
const clipboardSourceFiles = [
    'apps/tui/src/platform/clipboard-service.ts',
    'apps/tui/src/platform/selection-copy.ts',
] as const;
const testFilePattern = /\.(test|spec)\.(ts|tsx|mts|cts)$/u;

const skippedDirectoryNames: ReadonlySet<string> = new Set([
    '.nx',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'target',
]);
const productSourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const;

const opencodeImportTerms = ['@opencode-ai/'] as const;
const stateProviderImportTerms = [
    '@opentui/',
    "from 'solid-js",
    'from "solid-js',
    "from 'apps/tui/src/platform/providers/",
    'from "apps/tui/src/platform/providers/',
    "from './platform/providers/",
    'from "./platform/providers/',
    "from '../platform/providers/",
    'from "../platform/providers/',
    "from '../../platform/providers/",
    'from "../../platform/providers/',
    "from './providers/",
    'from "./providers/',
    "from '../providers/",
    'from "../providers/',
] as const;
const runtimeBridgeForbiddenTerms = ['AgentRuntime', 'AgentRuntimeOptions', 'ProviderAdapter', 'ToolRegistry'] as const;
const clipboardFallbackTerms = ['child_process', 'execSync', 'spawnSync', 'pbcopy', 'xclip', 'wl-copy'] as const;

const blockCommentPattern = /\/\*[\s\S]*?\*\//gu;
const lineCommentPattern = /\/\/.*$/gmu;

type GuardFinding = {
    readonly file: string;
    readonly term: string;
};

function normalizePath(path: string): string {
    return path.replaceAll('\\', '/');
}

function stripComments(source: string): string {
    return source.replace(blockCommentPattern, '').replace(lineCommentPattern, '');
}

function isProductTypeScriptSource(path: string): boolean {
    if (path.endsWith('.d.ts')) return false;
    if (testFilePattern.test(path)) return false;
    return productSourceExtensions.some((extension) => path.endsWith(extension));
}

function collectSourceFiles(directory: string): readonly string[] {
    const absoluteDirectory = join(root, directory);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDirectory)) {
        const relativePath = normalizePath(join(directory, entry));
        const absolutePath = join(root, relativePath);
        const entryStat = statSync(absolutePath);
        if (entryStat.isDirectory()) {
            if (!skippedDirectoryNames.has(entry)) {
                files.push(...collectSourceFiles(relativePath));
            }
            continue;
        }
        if (isProductTypeScriptSource(relativePath)) {
            files.push(relativePath);
        }
    }
    return files.sort();
}

function collectExistingSourceFiles(directory: string): readonly string[] {
    if (!existsSync(join(root, directory))) return [];
    return collectSourceFiles(directory);
}

function productSourceFiles(): readonly string[] {
    return productSourceRoots.flatMap((sourceRoot) => collectSourceFiles(sourceRoot));
}

function clipboardGuardFiles(): readonly string[] {
    const providerClipboardFiles = collectExistingSourceFiles(platformProvidersRoot).filter((file) =>
        basename(file).startsWith('clipboard'),
    );
    return [...clipboardSourceFiles, ...providerClipboardFiles].sort();
}

function scanSourceForTerms(file: string, source: string, terms: readonly string[]): readonly GuardFinding[] {
    return terms.flatMap((term) => (source.includes(term) ? [{ file, term }] : []));
}

function scanFilesForTerms(files: readonly string[], terms: readonly string[]): readonly GuardFinding[] {
    return files.flatMap((file) =>
        scanSourceForTerms(file, stripComments(readFileSync(join(root, file), 'utf8')), terms),
    );
}

function indexProviderExportFindings(source: string): readonly GuardFinding[] {
    return stripComments(source)
        .split('\n')
        .filter((line) => line.trimStart().startsWith('export '))
        .flatMap((line) => scanSourceForTerms(indexSourcePath, line, ['@opentui/', 'provider']));
}

function formatFindings(findings: readonly GuardFinding[]): string {
    return findings.map((finding) => `${finding.file}: forbidden term "${finding.term}"`).join('\n');
}

describe('TUI provider-port guardrails', () => {
    it('scanner flags an OpenCode SDK import in a synthetic source fixture', () => {
        const findings = scanSourceForTerms(
            'synthetic-opencode-fixture.ts',
            "import '@opencode-ai/sdk';",
            opencodeImportTerms,
        );

        expect(findings).toEqual([{ file: 'synthetic-opencode-fixture.ts', term: '@opencode-ai/' }]);
    });

    it('scanner flags provider runtime imports in a synthetic state source fixture', () => {
        const findings = scanSourceForTerms(
            'apps/tui/src/state/synthetic-provider-fixture.ts',
            "import { Provider } from '../platform/providers/provider.js';\nimport { createSignal } from 'solid-js';",
            stateProviderImportTerms,
        );

        expect(findings).toEqual([
            { file: 'apps/tui/src/state/synthetic-provider-fixture.ts', term: "from 'solid-js" },
            { file: 'apps/tui/src/state/synthetic-provider-fixture.ts', term: "from '../platform/providers/" },
        ]);
    });

    it('scanner flags provider exports in a synthetic barrel fixture', () => {
        const findings = indexProviderExportFindings("export * from './platform/providers/sdk-provider.js';");

        expect(findings).toEqual([{ file: indexSourcePath, term: 'provider' }]);
    });

    it('scanner flags full runtime references in a synthetic TUI source fixture', () => {
        const findings = scanSourceForTerms(
            'apps/tui/src/synthetic-runtime-fixture.ts',
            "import type { AgentRuntime, AgentRuntimeOptions, ProviderAdapter, ToolRegistry } from '@mission-control/core';",
            runtimeBridgeForbiddenTerms,
        );

        expect(findings).toEqual([
            { file: 'apps/tui/src/synthetic-runtime-fixture.ts', term: 'AgentRuntime' },
            { file: 'apps/tui/src/synthetic-runtime-fixture.ts', term: 'AgentRuntimeOptions' },
            { file: 'apps/tui/src/synthetic-runtime-fixture.ts', term: 'ProviderAdapter' },
            { file: 'apps/tui/src/synthetic-runtime-fixture.ts', term: 'ToolRegistry' },
        ]);
    });

    it('scanner flags clipboard child-process fallbacks in a synthetic source fixture', () => {
        const findings = scanSourceForTerms(
            'apps/tui/src/platform/synthetic-clipboard-fixture.ts',
            "import { spawnSync } from 'node:child_process';\nspawnSync('wl-copy');",
            clipboardFallbackTerms,
        );

        expect(findings).toEqual([
            { file: 'apps/tui/src/platform/synthetic-clipboard-fixture.ts', term: 'child_process' },
            { file: 'apps/tui/src/platform/synthetic-clipboard-fixture.ts', term: 'spawnSync' },
            { file: 'apps/tui/src/platform/synthetic-clipboard-fixture.ts', term: 'wl-copy' },
        ]);
    });

    it('no product source imports @opencode-ai packages', () => {
        // TDD proof: during implementation, a temporary product fixture importing
        // @opencode-ai/sdk was added under apps/tui/src; this guard failed on it,
        // then the fixture was removed before the green baseline run.
        const files = productSourceFiles();
        const findings = scanFilesForTerms(files, opencodeImportTerms);

        expect(files.length, 'product source scan must include apps/ and packages/ TypeScript files').toBeGreaterThan(
            0,
        );
        expect(findings, `product source must not import @opencode-ai packages\n${formatFindings(findings)}`).toEqual(
            [],
        );
    });

    it('no TUI state source imports provider runtime modules', () => {
        const findings = scanFilesForTerms(collectSourceFiles(stateSourceRoot), stateProviderImportTerms);

        expect(findings, `TUI state must stay provider-runtime free\n${formatFindings(findings)}`).toEqual([]);
    });

    it('no provider or OpenTUI modules are exported from the main TUI barrel', () => {
        const findings = indexProviderExportFindings(readFileSync(join(root, indexSourcePath), 'utf8'));

        expect(
            findings,
            `TUI main barrel must not export provider/OpenTUI modules\n${formatFindings(findings)}`,
        ).toEqual([]);
    });

    it('no TUI source refers to full runtime objects', () => {
        const findings = scanFilesForTerms(collectSourceFiles(tuiSourceRoot), runtimeBridgeForbiddenTerms);

        expect(
            findings,
            `TUI source must use structural callbacks instead of full runtime objects\n${formatFindings(findings)}`,
        ).toEqual([]);
    });

    it('no clipboard source imports child-process clipboard fallbacks', () => {
        const findings = scanFilesForTerms(clipboardGuardFiles(), clipboardFallbackTerms);

        expect(findings, `clipboard source must remain OSC52-only\n${formatFindings(findings)}`).toEqual([]);
    });
});
