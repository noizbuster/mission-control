import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export type SessionControlProcessIdentity = {
    readonly pid: number;
    readonly processStartId: string;
};

export type SessionControlProcessState = 'dead' | 'matching' | 'mismatched' | 'unknown';

const FALLBACK_PROCESS_START_ID = `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1_000)}`;

type SessionControlProcessProbeOptions = {
    readonly platform?: NodeJS.Platform;
    readonly readProcessStartId?: (pid: number) => Promise<string | undefined>;
};

export async function currentSessionControlProcessIdentity(
    options: SessionControlProcessProbeOptions = {},
): Promise<SessionControlProcessIdentity> {
    const processStartId = await (options.readProcessStartId ?? ((pid) => readProcessStartId(pid, options.platform)))(
        process.pid,
    );
    if (processStartId === undefined) {
        throw new Error('The current process start identity is unavailable');
    }
    return { pid: process.pid, processStartId };
}

export async function probeSessionControlProcess(
    pid: number,
    expectedProcessStartId: string,
    options: SessionControlProcessProbeOptions = {},
): Promise<SessionControlProcessState> {
    try {
        const observed = await (options.readProcessStartId ?? ((value) => readProcessStartId(value, options.platform)))(
            pid,
        );
        if (observed === undefined) return 'dead';
        return observed === expectedProcessStartId ? 'matching' : 'mismatched';
    } catch {
        return 'unknown';
    }
}

async function readProcessStartId(pid: number, platform = process.platform): Promise<string | undefined> {
    if (platform === 'linux') {
        try {
            const [bootId, stat] = await Promise.all([
                readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
                readFile(`/proc/${pid}/stat`, 'utf8'),
            ]);
            const commandEnd = stat.lastIndexOf(')');
            if (commandEnd < 0) return undefined;
            const fieldsAfterCommand = stat
                .slice(commandEnd + 2)
                .trim()
                .split(/\s+/u);
            const startTicks = fieldsAfterCommand[19];
            return startTicks === undefined ? undefined : `${bootId.trim()}:${startTicks}`;
        } catch (error: unknown) {
            if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ESRCH')) return undefined;
            throw error;
        }
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' || platform === 'netbsd') {
        return readCommandOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 1);
    }
    if (platform === 'win32') {
        return readCommandOutput(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){exit 3};$p.StartTime.ToUniversalTime().Ticks`,
            ],
            3,
        );
    }
    return pid === process.pid ? FALLBACK_PROCESS_START_ID : undefined;
}

function readCommandOutput(
    command: string,
    args: readonly string[],
    missingExitCode: number,
): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
            if (error !== null) {
                if ('code' in error && error.code === missingExitCode) resolve(undefined);
                else reject(error);
                return;
            }
            const output = stdout.trim();
            resolve(output.length === 0 ? undefined : output);
        });
    });
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
