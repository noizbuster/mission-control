import { describe, expect, it } from 'vitest';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = process.cwd();
const scanRoots = [
    '.github',
    'ABG.md',
    'AGENTS.md',
    'README.md',
    'apps',
    'biome.jsonc',
    'docs',
    'examples',
    'native',
    'nx.json',
    'package.json',
    'packages',
    'pnpm-workspace.yaml',
    'project.json',
    'scripts',
    'skills-lock.json',
    'tests',
    'tsconfig.base.json',
    'vitest.config.ts',
] as const;
const scannedExtensions = new Set([
    '.cjs',
    '.cts',
    '.js',
    '.json',
    '.jsonc',
    '.jsx',
    '.md',
    '.mjs',
    '.mts',
    '.rs',
    '.sh',
    '.sql',
    '.toml',
    '.ts',
    '.tsx',
    '.yaml',
    '.yml',
]);
const skippedDirectories = new Set(['.nx', 'build', 'coverage', 'dist', 'node_modules', 'target']);

const oneShotArtifact = ['one', 'shot', 'local', 'db', 'migration'].join('-');
const removedImportTable = ['local', 'db', 'imports'].join('_');
const removedImportError = ['Local', 'Db', 'Import', 'Error'].join('');
const removedRuntimeMigrationPath = ['runtime', 'db', 'migration'].join('-');
const removedRuntimeMigrationSymbol = ['runtime', 'db', 'migration'].join('_');
const sqlAttach = ['AT', 'TACH'].join('');
const runtimeSqlAttachPattern = new RegExp(`\\b${sqlAttach}\\s+(?:DATABASE\\s+)?(?:['"?]|file:)`, 'iu');
const oldDatabaseFilename = ['memory', 'db'].join('.');
const approvedLegacyMemoryReferences = [
    'packages/core/src/memory/turso-runtime-wiring.test.ts',
    'packages/core/src/runtime/local-runtime-db.test.ts',
    'packages/core/src/runtime/session-store-identity.test.ts',
] as const;
const approvedLegacyMemoryReferenceSet: ReadonlySet<string> = new Set(approvedLegacyMemoryReferences);

type ArtifactRuleId =
    | 'automatic-old-database-probe'
    | 'removed-import-error'
    | 'removed-import-table'
    | 'removed-one-shot-artifact'
    | 'removed-runtime-migration-artifact'
    | 'runtime-sql-attach';

type ArtifactFinding = {
    readonly file: string;
    readonly rule: ArtifactRuleId;
};

type SourceFile = {
    readonly path: string;
    readonly source: string;
};

function normalizePath(path: string): string {
    return path.replaceAll('\\', '/');
}

function extensionOf(path: string): string {
    const dotIndex = path.lastIndexOf('.');
    return dotIndex === -1 ? '' : path.slice(dotIndex);
}

function collectScannedFiles(path: string): readonly string[] {
    const absolutePath = join(repositoryRoot, path);
    const pathStat = lstatSync(absolutePath);
    if (pathStat.isSymbolicLink()) return [];
    if (!pathStat.isDirectory()) return scannedExtensions.has(extensionOf(path)) ? [path] : [];

    return readdirSync(absolutePath)
        .filter((entry) => !skippedDirectories.has(entry))
        .flatMap((entry) => collectScannedFiles(normalizePath(join(path, entry))))
        .sort();
}

function repositorySources(): readonly SourceFile[] {
    return scanRoots
        .flatMap((root) => collectScannedFiles(root))
        .map((path) => ({ path, source: readFileSync(join(repositoryRoot, path), 'utf8') }));
}

function scanStorageArtifacts(files: readonly SourceFile[]): readonly ArtifactFinding[] {
    const findings: ArtifactFinding[] = [];
    for (const file of files) {
        if (file.path.includes(oneShotArtifact) || file.source.includes(oneShotArtifact))
            findings.push({ file: file.path, rule: 'removed-one-shot-artifact' });
        if (file.source.includes(removedImportTable)) findings.push({ file: file.path, rule: 'removed-import-table' });
        if (file.source.includes(removedImportError)) findings.push({ file: file.path, rule: 'removed-import-error' });
        if (file.path.includes(removedRuntimeMigrationPath) || file.source.includes(removedRuntimeMigrationSymbol)) {
            findings.push({ file: file.path, rule: 'removed-runtime-migration-artifact' });
        }
        if (runtimeSqlAttachPattern.test(file.source)) {
            findings.push({ file: file.path, rule: 'runtime-sql-attach' });
        }
        if (file.source.includes(oldDatabaseFilename) && !approvedLegacyMemoryReferenceSet.has(file.path)) {
            findings.push({ file: file.path, rule: 'automatic-old-database-probe' });
        }
    }
    return findings;
}

describe('clean unified storage artifact guard', () => {
    it('rejects every prohibited migration artifact in seeded fixtures', () => {
        const seededSources: readonly SourceFile[] = [
            { path: 'packages/example/one-shot.ts', source: oneShotArtifact },
            { path: 'packages/example/import-table.sql', source: removedImportTable },
            { path: 'packages/example/import-error.ts', source: removedImportError },
            { path: `packages/example/${removedRuntimeMigrationPath}.ts`, source: '' },
            { path: 'packages/example/attach.ts', source: `${sqlAttach.toLowerCase()} database 'legacy.db'` },
            { path: 'packages/example/probe.ts', source: `existsSync(join(dataDir, '${oldDatabaseFilename}'))` },
        ];

        expect(scanStorageArtifacts(seededSources).map((finding) => finding.rule)).toEqual([
            'removed-one-shot-artifact',
            'removed-import-table',
            'removed-import-error',
            'removed-runtime-migration-artifact',
            'runtime-sql-attach',
            'automatic-old-database-probe',
        ]);
    });

    it('keeps the regenerated old-database reference inventory confined to negative tests', () => {
        const references = repositorySources()
            .filter((file) => file.source.includes(oldDatabaseFilename))
            .map((file) => file.path)
            .sort();

        expect(references).toEqual([...approvedLegacyMemoryReferences]);
    });

    it('preserves approved session import and schema migration vocabulary', () => {
        const sources = repositorySources();
        const legacySessionTable = ['legacy', 'session', 'imports'].join('_');
        const schemaMigrationTable = ['schema', 'migrations'].join('_');
        const approvedVocabulary = [
            {
                term: legacySessionTable,
                paths: [
                    'README.md',
                    'docs/session-data-model.md',
                    'packages/core/src/db/',
                    'packages/core/src/memory/',
                    'tests/readme-runtime-contract.test.ts',
                ],
            },
            {
                term: schemaMigrationTable,
                paths: ['packages/core/src/db/', 'tests/readme-contract.test.ts'],
            },
        ] as const;

        const scopeViolations = approvedVocabulary.flatMap(({ term, paths }) =>
            sources
                .filter((file) => file.source.includes(term))
                .filter((file) => !paths.some((path) => file.path === path || file.path.startsWith(path)))
                .map((file) => `${term}: ${file.path}`),
        );

        expect(
            readFileSync(join(repositoryRoot, 'packages/core/src/db/local-libsql-schema-memory.ts'), 'utf8'),
        ).toContain('memory_entries');
        expect(
            readFileSync(join(repositoryRoot, 'packages/core/src/db/local-libsql-schema-projections.ts'), 'utf8'),
        ).toContain(legacySessionTable);
        expect(readFileSync(join(repositoryRoot, 'packages/core/src/db/local-libsql-db.ts'), 'utf8')).toContain(
            schemaMigrationTable,
        );
        expect(readFileSync(join(repositoryRoot, 'packages/core/src/memory/session-import.ts'), 'utf8')).toContain(
            'importLegacySessionCompatibilityWindow',
        );
        expect(scopeViolations).toEqual([]);
    });

    it('finds no prohibited migration artifact in the final maintained tree', () => {
        expect(scanStorageArtifacts(repositorySources())).toEqual([]);
    });
});
