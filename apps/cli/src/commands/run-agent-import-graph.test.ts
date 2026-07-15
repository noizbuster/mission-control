import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const repositoryRoot = process.cwd();
const entryPoint = 'apps/cli/src/commands/run-agent.ts';
const forbiddenRuntimeSpecifiers = ['@opentui/', 'solid-js', 'node:ffi', '@mission-control/tui/highlight'] as const;

type ReachableModule = {
    readonly path: string;
    readonly importedBy: string | undefined;
};

function runtimeModuleSpecifiers(source: string, path: string): readonly string[] {
    const scanner = createScanner(true, path.endsWith('.tsx') ? LanguageVariant.JSX : LanguageVariant.Standard, source);
    const tokens: Array<{ readonly kind: SyntaxKind; readonly value: string }> = [];
    let previousEnd = -1;
    for (;;) {
        const kind = scanner.scan();
        if (kind === SyntaxKind.EndOfFile) break;
        const start = scanner.getTokenStart();
        const end = scanner.getTokenEnd();
        if (end <= previousEnd || end <= start) {
            scanner.resetTokenState(Math.min(source.length, start + 1));
            previousEnd = start;
            continue;
        }
        previousEnd = end;
        tokens.push({ kind, value: scanner.getTokenValue() });
    }
    return tokens.flatMap((token, index) => staticSpecifierAt(tokens, index, token));
}

function staticSpecifierAt(
    tokens: readonly { readonly kind: SyntaxKind; readonly value: string }[],
    index: number,
    token: { readonly kind: SyntaxKind; readonly value: string },
): readonly string[] {
    if (token.kind !== SyntaxKind.StringLiteral) return [];
    const previous = tokens[index - 1];
    if (previous?.kind === SyntaxKind.ImportKeyword) return [token.value];
    if (previous?.kind !== SyntaxKind.FromKeyword) return [];
    for (let cursor = index - 2; cursor >= 0; cursor -= 1) {
        const kind = tokens[cursor]?.kind;
        if (kind === SyntaxKind.ImportKeyword || kind === SyntaxKind.ExportKeyword) {
            return tokens[cursor + 1]?.kind === SyntaxKind.TypeKeyword ? [] : [token.value];
        }
        if (kind === SyntaxKind.SemicolonToken) return [];
    }
    return [];
}

function sourcePathForRelativeImport(fromPath: string, specifier: string): string | undefined {
    const basePath = join(dirname(fromPath), specifier.replace(/\.js$/u, ''));
    return [basePath, `${basePath}.ts`, `${basePath}.tsx`, join(basePath, 'index.ts')].find(existsSync);
}

function sourcePathForTuiSubpath(specifier: string): string | undefined {
    const packagePath = join(repositoryRoot, 'apps/tui/package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        readonly exports: Record<string, string>;
    };
    const exportPath = manifest.exports[specifier.replace('@mission-control/tui', '.')];
    if (exportPath === undefined) return undefined;
    const sourcePath = join(
        repositoryRoot,
        'apps/tui',
        exportPath.replace(/^\.\/dist\//u, 'src/').replace(/\.js$/u, ''),
    );
    return [sourcePath, `${sourcePath}.ts`, `${sourcePath}.tsx`].find(existsSync);
}

function collectReachableRuntimeModules(): readonly ReachableModule[] {
    const pending: ReachableModule[] = [{ path: join(repositoryRoot, entryPoint), importedBy: undefined }];
    const visited = new Set<string>();
    const modules: ReachableModule[] = [];
    while (pending.length > 0) {
        const next = pending.pop();
        if (next === undefined || visited.has(next.path)) continue;
        visited.add(next.path);
        modules.push(next);
        const source = readFileSync(next.path, 'utf8');
        for (const specifier of runtimeModuleSpecifiers(source, next.path)) {
            const localPath = specifier.startsWith('.') ? sourcePathForRelativeImport(next.path, specifier) : undefined;
            const tuiPath = specifier.startsWith('@mission-control/tui')
                ? sourcePathForTuiSubpath(specifier)
                : undefined;
            const resolvedPath = localPath ?? tuiPath;
            if (resolvedPath !== undefined) pending.push({ path: resolvedPath, importedBy: next.path });
        }
    }
    return modules;
}

describe('run-agent noninteractive runtime import graph', () => {
    it('keeps OpenTUI, Solid, and highlighting outside the static graph from the actual CLI runner entry', () => {
        const violations: string[] = [];
        for (const module of collectReachableRuntimeModules()) {
            const source = readFileSync(module.path, 'utf8');
            for (const specifier of runtimeModuleSpecifiers(source, module.path)) {
                if (forbiddenRuntimeSpecifiers.some((forbidden) => specifier.includes(forbidden))) {
                    violations.push(
                        `${relative(repositoryRoot, module.path)} imports ${specifier}${
                            module.importedBy === undefined ? '' : ` via ${relative(repositoryRoot, module.importedBy)}`
                        }`,
                    );
                }
            }
        }
        expect(violations, `noninteractive runner reached TUI runtime modules\n${violations.join('\n')}`).toEqual([]);
    });
});
