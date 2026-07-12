import type { Client } from '@libsql/client';
import { z } from 'zod';
import { watch } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { basename, dirname } from 'node:path';

type MissionControlDbModule = typeof import('../mission-control-db.js');
type LocalLibsqlDbModule = typeof import('../local-libsql-db.js');

const sourceRootUrl = new URL('../../', import.meta.url).href;
const workerDeadlineMs = 12_000;
const databaseAttemptMarkerKey = 'mission-control.task-11.database-attempt';
const workerArgsSchema = z.union([
    z.tuple([z.literal('write'), z.string().min(1), z.string().min(1)]),
    z.tuple([z.literal('hold'), z.string().min(1), z.string().min(1), z.string().min(1)]),
    z.tuple([z.literal('race-leader'), z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]),
    z.tuple([z.literal('race-follower'), z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]),
    z.tuple([z.literal('crash'), z.string().min(1), z.string().min(1), z.string().min(1)]),
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (
            context.parentURL?.startsWith(sourceRootUrl) === true &&
            specifier.startsWith('.') &&
            specifier.endsWith('.js')
        ) {
            return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (
            !url.startsWith(sourceRootUrl) ||
            !url.endsWith('.ts') ||
            loaded.source === null ||
            loaded.source === undefined
        ) {
            return loaded;
        }
        let source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
        if (url.endsWith('/local-libsql-write-lane.ts')) {
            source = source.replace(
                `    constructor(readonly code: LocalDbWriteErrorCode) {
        super(\`Local libSQL write lane rejected acquisition (\${code})\`);
    }`,
                `    readonly code: LocalDbWriteErrorCode;

    constructor(code: LocalDbWriteErrorCode) {
        super(\`Local libSQL write lane rejected acquisition (\${code})\`);
        this.code = code;
    }`,
            );
        }
        if (url.endsWith('/local-libsql-pragmas.ts')) {
            source = source.replace(
                `    constructor(
        readonly code: LocalDbInitializationErrorCode,
        readonly pragma: LocalDbPragma,
        readonly expected: LocalDbPragmaExpected,
        readonly actual: LocalDbPragmaActual,
    ) {
        super(\`Local libSQL \${pragma} initialization expected \${String(expected)}, received \${String(actual)}\`);
    }`,
                `    readonly code: LocalDbInitializationErrorCode;
    readonly pragma: LocalDbPragma;
    readonly expected: LocalDbPragmaExpected;
    readonly actual: LocalDbPragmaActual;

    constructor(
        code: LocalDbInitializationErrorCode,
        pragma: LocalDbPragma,
        expected: LocalDbPragmaExpected,
        actual: LocalDbPragmaActual,
    ) {
        super(\`Local libSQL \${pragma} initialization expected \${String(expected)}, received \${String(actual)}\`);
        this.code = code;
        this.pragma = pragma;
        this.expected = expected;
        this.actual = actual;
    }`,
            );
            source = source.replace(
                "    const requestedJournalMode = await client.execute('PRAGMA journal_mode=WAL');",
                `    const journalModeRequest = client.execute('PRAGMA journal_mode=WAL');
    const attemptMarker = Reflect.get(globalThis, Symbol.for('${databaseAttemptMarkerKey}'));
    if (typeof attemptMarker === 'function') attemptMarker();
    const requestedJournalMode = await journalModeRequest;`,
            );
        }
        return { ...loaded, source };
    },
});

const missionControlDbModuleUrl = new URL('../mission-control-db.ts', import.meta.url).href;
const localLibsqlDbModuleUrl = new URL('../local-libsql-db.ts', import.meta.url).href;
const missionControlDbModule: MissionControlDbModule = await import(missionControlDbModuleUrl);
const localLibsqlDbModule: LocalLibsqlDbModule = await import(localLibsqlDbModuleUrl);

const deadline = setTimeout(() => {
    emitMarker('ERROR', 'worker deadline exceeded');
    process.exit(2);
}, workerDeadlineMs);
deadline.unref();

runWorker().then(
    () => clearTimeout(deadline),
    (error: unknown) => {
        clearTimeout(deadline);
        emitMarker('ERROR', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        process.exitCode = 1;
    },
);

async function runWorker(): Promise<void> {
    const args = workerArgsSchema.parse(process.argv.slice(2));
    switch (args[0]) {
        case 'write':
            emitMarker('READY');
            await writeRow(args[1], args[2]);
            return;
        case 'race-leader':
            emitMarker('READY');
            await waitForFile(args[3]);
            await writeRow(args[1], args[2], args[4]);
            return;
        case 'race-follower':
            emitMarker('READY');
            await waitForFile(args[3]);
            await waitForFile(args[4]);
            await writeRow(args[1], args[2]);
            return;
        case 'hold':
        case 'crash':
            emitMarker('READY');
            await holdTransaction(args[1], args[2], args[3]);
            return;
        default:
            assertNever(args);
    }
}

async function writeRow(dataDir: string, key: string, openedPath?: string): Promise<void> {
    const markerSymbol = Symbol.for(databaseAttemptMarkerKey);
    Reflect.set(globalThis, markerSymbol, () => emitMarker('LOCKED'));
    let runtime: Awaited<ReturnType<MissionControlDbModule['openMissionControlDb']>> | undefined;
    try {
        runtime = await missionControlDbModule.openMissionControlDb({ dataDir });
        Reflect.deleteProperty(globalThis, markerSymbol);
        if (openedPath !== undefined) await writeFile(openedPath, 'opened', 'utf8');
        await localLibsqlDbModule.runLocalLibsqlWrite(runtime, (client) => insertRow(client, key));
        emitMarker('COMMITTED');
    } finally {
        Reflect.deleteProperty(globalThis, markerSymbol);
        runtime?.close();
    }
}

async function holdTransaction(dataDir: string, key: string, releasePath: string): Promise<void> {
    const runtime = await missionControlDbModule.openMissionControlDb({ dataDir });
    try {
        await localLibsqlDbModule.runLocalLibsqlWrite(runtime, async (client) => {
            await client.execute('BEGIN IMMEDIATE TRANSACTION');
            try {
                await insertRow(client, key);
                emitMarker('LOCKED');
                await waitForFile(releasePath);
                await client.execute('COMMIT');
                emitMarker('COMMITTED');
            } catch (error: unknown) {
                await client.execute('ROLLBACK');
                throw error;
            }
        });
    } finally {
        runtime.close();
    }
}

async function insertRow(client: Client, key: string): Promise<void> {
    await client.execute({
        sql: 'INSERT INTO memory_entries (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
        args: ['task-11', key, JSON.stringify({ key }), new Date().toISOString()],
    });
}

async function waitForFile(filePath: string): Promise<void> {
    const signal = AbortSignal.timeout(workerDeadlineMs);
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const watcher = watch(dirname(filePath), { signal }, (_eventType, filename) => {
            if (filename === null || filename.toString() === basename(filePath)) void check();
        });
        const finish = (outcome: 'resolve' | 'reject', error?: unknown): void => {
            if (settled) return;
            settled = true;
            watcher.close();
            if (outcome === 'resolve') resolve();
            else reject(error);
        };
        const check = async (): Promise<void> => {
            try {
                await access(filePath);
                finish('resolve');
            } catch (error: unknown) {
                if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return;
                finish('reject', error);
            }
        };
        watcher.on('error', (error) => {
            if (!signal.aborted) finish('reject', error);
        });
        signal.addEventListener('abort', () => finish('reject', new WorkerDeadlineError(filePath)), { once: true });
        void check();
    });
}

class WorkerDeadlineError extends Error {
    constructor(filePath: string) {
        super(`worker gate deadline exceeded: ${filePath}`);
        this.name = 'WorkerDeadlineError';
    }
}

function emitMarker(marker: 'READY' | 'LOCKED' | 'COMMITTED' | 'ERROR', detail?: string): void {
    const normalizedDetail = detail?.replace(/\s+/gu, ' ').trim();
    process.stdout.write(`${marker}${normalizedDetail === undefined ? '' : ` ${normalizedDetail}`}\n`);
}

function assertNever(value: never): never {
    throw new TypeError(`unexpected worker command: ${JSON.stringify(value)}`);
}
