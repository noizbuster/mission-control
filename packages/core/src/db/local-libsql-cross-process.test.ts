import { afterEach, describe, expect, it } from 'vitest';
import { runLocalLibsqlWrite } from './local-libsql-db';
import { openMissionControlDb } from './mission-control-db';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./test-fixtures/local-db-worker.ts', import.meta.url));
const workers = new Set<WorkerProbe>();
const tempDirs: string[] = [];
afterEach(async () => {
    try {
        const settlements = await Promise.allSettled([...workers].map((worker) => worker.terminate()));
        const failures = settlements.flatMap((settlement) =>
            settlement.status === 'rejected' ? [settlement.reason] : [],
        );
        if (failures.length > 0) throw new AggregateError(failures, 'worker teardown failed');
    } finally {
        workers.clear();
        await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    }
});
describe('local libSQL cross-process contention and crash recovery', () => {
    it('waits for a cross-process lock and commits before the 5000ms busy timeout', async () => {
        // Given: one real worker owns BEGIN IMMEDIATE on the product database.
        const dataDir = await makeDataDir('wait-success');
        const releasePath = join(dataDir, 'release-holder');
        const holder = startWorker(['hold', dataDir, 'held-row', releasePath]);
        await holder.waitFor('READY');
        await holder.waitFor('LOCKED');
        const writer = startWorker(['write', dataDir, 'waited-row']);
        await writer.waitFor('READY');
        await writer.waitFor('LOCKED');

        // When: the holder releases only after the second process has attempted its write.
        expect(writer.hasMarker('COMMITTED')).toBe(false);
        await writeFile(releasePath, 'release', 'utf8');
        await writer.waitFor('COMMITTED');

        // Then: both workers commit in lock order and another write succeeds.
        expect(await holder.waitForExit()).toMatchObject({ code: 0, signal: null });
        expect(await writer.waitForExit()).toMatchObject({ code: 0, signal: null });
        expect(await assertHealthyAndWrite(dataDir, 'follow-up-success')).toEqual([
            'follow-up-success',
            'held-row',
            'waited-row',
        ]);
    }, 15_000);
    it('surfaces the configured busy failure without corrupting the database', async () => {
        // Given: a holder keeps BEGIN IMMEDIATE beyond the configured busy timeout.
        const dataDir = await makeDataDir('wait-timeout');
        const releasePath = join(dataDir, 'release-timeout-holder');
        const holder = startWorker(['hold', dataDir, 'held-through-timeout', releasePath]);
        await holder.waitFor('READY');
        await holder.waitFor('LOCKED');
        const writer = startWorker(['write', dataDir, 'timed-out-row']);
        await writer.waitFor('READY');
        await writer.waitFor('LOCKED');

        // When: the second process reaches SQLite's real busy deadline.
        const errorLine = await writer.waitFor('ERROR', 8_000);

        // Then: the waiting write fails while the holder remains active, then the DB recovers after release.
        expect(errorLine).toMatch(/busy|locked/iu);
        expect(writer.hasMarker('COMMITTED')).toBe(false);
        expect(holder.hasMarker('COMMITTED')).toBe(false);
        expect(await writer.waitForExit()).toMatchObject({ code: 1, signal: null });
        await writeFile(releasePath, 'release', 'utf8');
        await holder.waitFor('COMMITTED');
        expect(await holder.waitForExit()).toMatchObject({ code: 0, signal: null });
        expect(await assertHealthyAndWrite(dataDir, 'follow-up-timeout')).toEqual([
            'follow-up-timeout',
            'held-through-timeout',
        ]);
    }, 15_000);
    it('initializes one fresh schema safely when two processes first-open in parallel', async () => {
        // Given: two workers launch in parallel beside one fresh data directory.
        const dataDir = await makeDataDir('first-open');
        const startPath = join(dataDir, 'start-first-open');
        const leaderOpenedPath = join(dataDir, 'leader-opened');
        const first = startWorker(['race-leader', dataDir, 'first-open-a', startPath, leaderOpenedPath]);
        const second = startWorker(['race-follower', dataDir, 'first-open-b', startPath, leaderOpenedPath]);

        // When: both processes initialize and write through the product opener.
        await Promise.all([first.waitFor('READY'), second.waitFor('READY')]);
        await writeFile(startPath, 'start', 'utf8');
        await Promise.all([first.waitFor('LOCKED'), second.waitFor('LOCKED')]);
        await Promise.all([first.waitFor('COMMITTED'), second.waitFor('COMMITTED')]);

        // Then: neither reports a lock error and the singular schema accepts a follow-up write.
        expect(first.hasMarker('ERROR')).toBe(false);
        expect(second.hasMarker('ERROR')).toBe(false);
        expect(await first.waitForExit()).toMatchObject({ code: 0, signal: null });
        expect(await second.waitForExit()).toMatchObject({ code: 0, signal: null });
        const runtime = await openMissionControlDb({ dataDir });
        try {
            const schema = await runtime.client.execute(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
            );
            expect(schema.rows).toEqual([{ count: 1 }]);
        } finally {
            runtime.close();
        }
        expect(await assertHealthyAndWrite(dataDir, 'follow-up-first-open')).toEqual([
            'first-open-a',
            'first-open-b',
            'follow-up-first-open',
        ]);
    }, 15_000);
    it('rolls back an uncommitted SIGKILL transaction and recovers the next write', async () => {
        // Given: a committed prefix exists before a worker inserts an uncommitted row.
        const dataDir = await makeDataDir('crash');
        expect(await assertHealthyAndWrite(dataDir, 'committed-prefix')).toEqual(['committed-prefix']);
        const releasePath = join(dataDir, 'never-release-crash');
        const crashing = startWorker(['crash', dataDir, 'uncommitted-crash-row', releasePath]);
        await crashing.waitFor('READY');
        await crashing.waitFor('LOCKED');

        // When: the transaction owner is killed without COMMIT or ROLLBACK.
        expect(crashing.child.kill('SIGKILL')).toBe(true);
        expect(await crashing.waitForExit()).toMatchObject({ code: null, signal: 'SIGKILL' });

        // Then: SQLite discards the uncommitted row, preserves the prefix, and permits a healthy follow-up write.
        expect(await assertHealthyAndWrite(dataDir, 'follow-up-crash')).toEqual([
            'committed-prefix',
            'follow-up-crash',
        ]);
    }, 15_000);
});
type WorkerMarker = 'READY' | 'LOCKED' | 'COMMITTED' | 'ERROR';
type WorkerExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
class WorkerProbe {
    readonly child: ReturnType<typeof spawnWorkerProcess>;
    private readonly events = new EventEmitter();
    private readonly lines: string[] = [];
    private readonly exit: Promise<WorkerExit>;
    private stderr = '';
    private stdoutBuffer = '';

    constructor(args: readonly string[]) {
        this.child = spawnWorkerProcess(args);
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.acceptStdout(chunk));
        this.child.stderr.on('data', (chunk: string) => {
            this.stderr += chunk;
        });
        this.exit = new Promise<WorkerExit>((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('close', (code, signal) => resolve({ code, signal }));
        });
    }

    hasMarker(marker: WorkerMarker): boolean {
        return this.lines.some((line) => line === marker || line.startsWith(`${marker} `));
    }

    async waitFor(marker: WorkerMarker, timeoutMs = 10_000): Promise<string> {
        const existing = this.lines.find((line) => line === marker || line.startsWith(`${marker} `));
        if (existing !== undefined) return existing;
        const signal = AbortSignal.timeout(timeoutMs);
        await Promise.race([
            once(this.events, marker, { signal }),
            this.exit.then((status) => {
                throw new Error(
                    `worker exited before ${marker}: ${JSON.stringify(status)} stderr=${this.stderr} stdout=${this.lines.join('|')}`,
                );
            }),
        ]);
        const line = this.lines.find((candidate) => candidate === marker || candidate.startsWith(`${marker} `));
        if (line === undefined) throw new Error(`worker emitted ${marker} without a complete marker line`);
        return line;
    }

    async waitForExit(timeoutMs = 3_000): Promise<WorkerExit> {
        return Promise.race([this.exit, rejectAtDeadline(timeoutMs, `worker exit deadline; stderr=${this.stderr}`)]);
    }

    async terminate(): Promise<void> {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
        await this.waitForExit();
    }

    private acceptStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        for (;;) {
            const newline = this.stdoutBuffer.indexOf('\n');
            if (newline < 0) return;
            const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            this.lines.push(line);
            const marker = line.split(' ', 1)[0];
            if (marker !== undefined) this.events.emit(marker);
        }
    }
}
function spawnWorkerProcess(args: readonly string[]) {
    return spawn(process.execPath, ['--experimental-strip-types', fixturePath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function startWorker(args: readonly string[]): WorkerProbe {
    const worker = new WorkerProbe(args);
    workers.add(worker);
    return worker;
}

async function makeDataDir(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `mctrl-task-11-${name}-`));
    tempDirs.push(directory);
    return directory;
}

async function assertHealthyAndWrite(dataDir: string, key: string): Promise<readonly string[]> {
    const runtime = await openMissionControlDb({ dataDir });
    try {
        expect((await runtime.client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
        await runLocalLibsqlWrite(runtime, (client) =>
            client
                .execute({
                    sql: 'INSERT INTO memory_entries (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
                    args: ['task-11', key, JSON.stringify({ key }), new Date().toISOString()],
                })
                .then(() => undefined),
        );
        const rows = await runtime.client.execute(
            "SELECT key FROM memory_entries WHERE namespace = 'task-11' ORDER BY key",
        );
        return rows.rows.map((row) => String(row[0]));
    } finally {
        runtime.close();
    }
}

function rejectAtDeadline(timeoutMs: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
        AbortSignal.timeout(timeoutMs).addEventListener('abort', () => reject(new Error(message)), { once: true });
    });
}
