import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type SourceFile = {
    readonly path: string;
    readonly source: string;
};

const sourceRoot = join(process.cwd(), 'packages/core/src');
const productionDirectories = ['db', 'memory', 'runtime', 'context', 'agents'] as const;

describe('local libSQL write architecture', () => {
    it('rejects seeded write-lane bypass fixtures', () => {
        // Given
        const seeded: readonly SourceFile[] = [
            { path: 'memory/transaction-bypass.ts', source: 'await db.transaction(async () => undefined);' },
            {
                path: 'memory/sqlite-session-event-store-transaction.ts',
                source: "await client.execute('BEGIN IMMEDIATE'); await client.batch([], 'write');",
            },
            {
                path: 'agents/production-bypass.ts',
                source: 'await SqlAgentJobMirror.createForTests(client);',
            },
            {
                path: 'agents/agent-job-sql-mirror.ts',
                source: 'static async create(input: Client | LocalLibsqlWriteTarget) {}',
            },
            {
                path: 'agents/index.ts',
                source: "export { SqlAgentJobMirror } from './agent-job-sql-mirror';",
            },
            {
                path: 'memory/turso-persistent-store.ts',
                source: 'await this.runtime.db.insert(memoryEntries).values({});',
            },
            {
                path: 'memory/read-path.ts',
                source: 'await ensureLocalDbSchema(client);',
            },
        ];

        // When
        const violations = auditWriteArchitecture(seeded);

        // Then
        expect(violations.map((violation) => violation.code).sort()).toEqual([
            'bare_drizzle_mutation',
            'batch_inside_manual_transaction',
            'interactive_transaction',
            'production_create_for_tests',
            'public_test_constructor_export',
            'read_path_schema_initialization',
            'target_untyped_mirror_create',
        ]);
    });

    it('keeps production local database writes on approved lane boundaries', () => {
        // Given
        const productionSources = productionDirectories.flatMap((directory) =>
            readProductionSources(join(sourceRoot, directory)),
        );

        // When
        const violations = auditWriteArchitecture(productionSources);

        // Then
        expect(violations).toEqual([]);
    });
});

type ArchitectureViolation = {
    readonly code:
        | 'interactive_transaction'
        | 'batch_inside_manual_transaction'
        | 'production_create_for_tests'
        | 'public_test_constructor_export'
        | 'read_path_schema_initialization'
        | 'target_untyped_mirror_create'
        | 'bare_drizzle_mutation';
    readonly path: string;
};

function auditWriteArchitecture(files: readonly SourceFile[]): readonly ArchitectureViolation[] {
    const violations: ArchitectureViolation[] = [];
    for (const file of files) {
        if (/\.transaction\s*\(/u.test(file.source)) {
            violations.push({ code: 'interactive_transaction', path: file.path });
        }
        if (file.path.endsWith('sqlite-session-event-store-transaction.ts') && /\.batch\s*\(/u.test(file.source)) {
            violations.push({ code: 'batch_inside_manual_transaction', path: file.path });
        }
        if (
            file.path !== 'agents/agent-job-sql-mirror.ts' &&
            /SqlAgentJobMirror\.createForTests\s*\(/u.test(file.source)
        ) {
            violations.push({ code: 'production_create_for_tests', path: file.path });
        }
        if (file.path === 'agents/index.ts' && /\bSqlAgentJobMirror\b/u.test(file.source)) {
            violations.push({ code: 'public_test_constructor_export', path: file.path });
        }
        if (
            file.path !== 'db/local-libsql-db.ts' &&
            file.path !== 'db/local-libsql-schema.ts' &&
            /ensureLocalDbSchema\s*\(/u.test(file.source)
        ) {
            violations.push({ code: 'read_path_schema_initialization', path: file.path });
        }
        if (
            file.path.endsWith('agents/agent-job-sql-mirror.ts') &&
            !/static async create\(input: LocalLibsqlWriteTarget\)/u.test(file.source)
        ) {
            violations.push({ code: 'target_untyped_mirror_create', path: file.path });
        }
        if (file.path.endsWith('memory/turso-persistent-store.ts')) {
            const mutationCount = [...file.source.matchAll(/\.(?:insert|delete)\s*\(/gu)].length;
            const admissionCount = [...file.source.matchAll(/runLocalLibsqlWrite\s*\(/gu)].length;
            if (mutationCount > admissionCount) violations.push({ code: 'bare_drizzle_mutation', path: file.path });
        }
    }
    return violations;
}

function readProductionSources(directory: string): readonly SourceFile[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return readProductionSources(path);
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.includes('test-support')) {
            return [];
        }
        return [{ path: relative(sourceRoot, path), source: readFileSync(path, 'utf8') }];
    });
}
