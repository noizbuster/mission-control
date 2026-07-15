import { afterEach, describe, expect, it } from 'vitest';
import { EvalPythonKernel } from './eval-python-kernel';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
const canRunPython = spawnSync('python3', ['--version'], { shell: false, stdio: 'ignore' }).status === 0;

describe.skipIf(process.platform === 'win32' || !canRunPython)('EvalPythonKernel POSIX descendant cleanup', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    it('leaves no descendant after a timed-out cell', async () => {
        // Given
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-eval-descendant-'));
        tempDirs.push(directory);
        const pidPath = join(directory, 'descendant.pid');
        const kernel = new EvalPythonKernel();
        let descendantPid: number | undefined;

        try {
            // When
            const result = await kernel.runCode({ code: descendantCode(pidPath), timeoutMs: 1_000 });
            descendantPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);

            // Then
            expect(result).toEqual({ output: '', exitCode: 124, truncated: false, timedOut: true });
            expect(Number.isSafeInteger(descendantPid)).toBe(true);
            await expect(waitForProcessExit(descendantPid)).resolves.toBeUndefined();
        } finally {
            await kernel.close();
            killIfRunning(descendantPid);
        }
    }, 10_000);
});

function descendantCode(pidPath: string): string {
    return [
        'import subprocess, sys, time',
        `child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])`,
        `with open(${JSON.stringify(pidPath)}, "w", encoding="utf-8") as pid_file:`,
        '    pid_file.write(str(child.pid))',
        '    pid_file.flush()',
        'while True:',
        '    time.sleep(1)',
    ].join('\n');
}

async function waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`descendant process ${String(pid)} remained alive`);
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (isEsrch(error)) {
            return false;
        }
        throw error;
    }
}

function killIfRunning(pid: number | undefined): void {
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch (error) {
        if (!isEsrch(error)) {
            throw error;
        }
    }
}

function isEsrch(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
