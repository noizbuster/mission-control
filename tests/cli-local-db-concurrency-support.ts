import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cliEntryPath = join(repositoryRoot, 'apps', 'cli', 'dist', 'index.js');
const drainPreloadUrl = pathToFileURL(join(repositoryRoot, 'tests', 'fixtures', 'cli-local-db-drain-preload.mjs')).href;
const preopenPreloadUrl = pathToFileURL(
    join(repositoryRoot, 'tests', 'fixtures', 'cli-local-db-preopen-preload.mjs'),
).href;
const lockWorkerPath = join(repositoryRoot, 'packages', 'core', 'src', 'db', 'test-fixtures', 'local-db-worker.ts');
const processes = new Set<CapturedProcess>();

class BuiltCliArtifactMissingError extends Error {
    readonly artifactPath: string;

    constructor(artifactPath: string) {
        super(
            `Built CLI artifact is missing at ${artifactPath}. Build it once before focused Vitest runs: NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:build`,
        );
        this.name = 'BuiltCliArtifactMissingError';
        this.artifactPath = artifactPath;
    }
}

export type ProcessResult = {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
};

export class CapturedProcess {
    readonly child: ChildProcessWithoutNullStreams;
    private readonly events = new EventEmitter();
    private readonly exit: Promise<ProcessResult>;
    private stdout = '';
    private stderr = '';
    private stdoutBuffer = '';

    constructor(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
        this.child = spawn(command, args, {
            cwd: repositoryRoot,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.acceptStdout(chunk));
        this.child.stderr.on('data', (chunk: string) => {
            this.stderr += chunk;
        });
        this.exit = new Promise<ProcessResult>((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('close', (code, signal) => {
                resolve({
                    code,
                    signal,
                    stdout: this.stdout,
                    stderr: this.stderr,
                });
            });
        });
        processes.add(this);
    }

    async waitForExit(timeoutMs = 30_000): Promise<ProcessResult> {
        const result = await Promise.race([
            this.exit,
            rejectAtDeadline(timeoutMs, `process exit deadline: ${this.child.spawnargs.join(' ')}`),
        ]);
        processes.delete(this);
        return result;
    }

    async waitForMarker(marker: string, timeoutMs = 10_000): Promise<string> {
        const existing = this.completeLines().find((line) => line === marker || line.startsWith(`${marker} `));
        if (existing !== undefined) return existing;
        const signal = AbortSignal.timeout(timeoutMs);
        await Promise.race([
            once(this.events, marker, { signal }),
            this.exit.then((result) => {
                throw new Error(
                    `process exited before ${marker}: ${JSON.stringify(result)} args=${this.child.spawnargs.join(' ')}`,
                );
            }),
        ]);
        const line = this.completeLines().find(
            (candidate) => candidate === marker || candidate.startsWith(`${marker} `),
        );
        if (line === undefined) throw new Error(`process emitted ${marker} without a complete marker line`);
        return line;
    }

    async terminate(): Promise<void> {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
        await this.exit;
        processes.delete(this);
    }

    private acceptStdout(chunk: string): void {
        this.stdout += chunk;
        this.stdoutBuffer += chunk;
        for (;;) {
            const newline = this.stdoutBuffer.indexOf('\n');
            if (newline < 0) return;
            const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            const marker = line.split(' ', 1)[0];
            if (marker !== undefined) this.events.emit(marker);
        }
    }

    private completeLines(): readonly string[] {
        return this.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
    }
}

export function resolveBuiltCliEntryPath(): string {
    if (!existsSync(cliEntryPath)) throw new BuiltCliArtifactMissingError(cliEntryPath);
    return cliEntryPath;
}

export function startBuiltCli(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    drainSessionId?: string,
): CapturedProcess {
    const entryPath = resolveBuiltCliEntryPath();
    const nodeArgs = [
        '--experimental-ffi',
        ...(drainSessionId === undefined ? [] : ['--import', drainPreloadUrl]),
        entryPath,
        ...args,
    ];
    return new CapturedProcess(process.execPath, nodeArgs, {
        ...env,
        ...(drainSessionId === undefined ? {} : { MCTRL_TASK12_DRAIN_SESSION_ID: drainSessionId }),
    });
}

export function startLockHolder(dataDir: string, releasePath: string): CapturedProcess {
    return new CapturedProcess(process.execPath, [
        '--experimental-strip-types',
        lockWorkerPath,
        'hold',
        dataDir,
        'task-12-held-row',
        releasePath,
    ]);
}

export function startPreopenedBuiltCli(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    releasePath: string,
): CapturedProcess {
    const entryPath = resolveBuiltCliEntryPath();
    return new CapturedProcess(
        process.execPath,
        ['--experimental-ffi', '--import', preopenPreloadUrl, entryPath, ...args],
        { ...env, MCTRL_TASK12_PREOPEN_RELEASE_PATH: releasePath },
    );
}

export async function makeTask12TempRoot(name: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `mctrl-task-12-${name}-`));
}

export async function terminateTask12Processes(): Promise<void> {
    const settlements = await Promise.allSettled([...processes].map((process) => process.terminate()));
    const failures = settlements.flatMap((settlement) => (settlement.status === 'rejected' ? [settlement.reason] : []));
    if (failures.length > 0) throw new AggregateError(failures, 'Task 12 process teardown failed');
}

function rejectAtDeadline(timeoutMs: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
        AbortSignal.timeout(timeoutMs).addEventListener('abort', () => reject(new Error(message)), { once: true });
    });
}
