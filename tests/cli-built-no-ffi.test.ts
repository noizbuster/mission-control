import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryRoot = process.cwd();
const cliEntry = join(repositoryRoot, 'apps/cli/dist/index.js');
const temporaryRoots: string[] = [];

type BuiltCliResult = {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
};

function runBuiltCli(args: readonly string[], dataDir: string): Promise<BuiltCliResult> {
    const child = spawn(process.execPath, [cliEntry, ...args], {
        cwd: repositoryRoot,
        env: { ...process.env, MCTRL_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function jsonLines(output: string): readonly { readonly type?: string }[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { readonly type?: string });
}

describe('built noninteractive CLI without experimental FFI', () => {
    afterEach(async () => {
        await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('runs no-tui, json, and jsonl modes without loading the native TUI runtime', async () => {
        expect(existsSync(cliEntry), `build CLI before this test: ${cliEntry}`).toBe(true);
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-no-ffi-built-'));
        temporaryRoots.push(dataDir);

        const plain = await runBuiltCli(['--no-tui', '--provider', 'local', '--model', 'local-echo'], dataDir);
        const json = await runBuiltCli(['--json', '--provider', 'local', '--model', 'local-echo'], dataDir);
        const sessionId = 'no_ffi_jsonl_session';
        const jsonl = await runBuiltCli(
            [
                'run',
                'summarize this repository',
                '--jsonl',
                '--session',
                sessionId,
                '--provider',
                'local',
                '--model',
                'local-echo',
            ],
            dataDir,
        );

        expect(plain.code).toBe(0);
        expect(plain.stdout).toContain('> local · local-echo');
        expect(json.code).toBe(0);
        expect(jsonLines(json.stdout).some((record) => record.type === 'task.completed')).toBe(true);
        expect(jsonl.code).toBe(0);
        expect(jsonLines(jsonl.stdout).some((record) => record.type === 'session.stopped')).toBe(true);
        await expect(stat(join(dataDir, 'mission-control.db'))).resolves.toBeDefined();
        expect(`${plain.stderr}${json.stderr}${jsonl.stderr}`).not.toMatch(/node:ffi|experimental[- ]ffi|@opentui/u);
    });
});
