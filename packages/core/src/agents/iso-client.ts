/**
 * Iso (workspace isolation) client for task() worktree fan-out.
 *
 * Bridges the agent layer to the sidecar `iso.resolve` / `iso.diff` v3
 * capabilities (see `native/sidecar/src/iso.rs`). On platforms where the
 * sidecar reports isolation `unsupported` (or the invocation itself fails),
 * `resolve` falls back to an in-process recursive directory copy so the
 * caller always gets an independent writable worktree. `diff` has no
 * in-process fallback: it surfaces a clean error so the caller can decide.
 *
 * Capability class `subagent`: this is an internal helper consumed by the
 * task-tool runtime, not a model-callable tool.
 */

import {
    SIDECAR_PROTOCOL_V3_VERSION,
    type SidecarIsoDiffResponse,
    SidecarIsoDiffResponseSchema,
    type SidecarIsoResolveResponse,
    SidecarIsoResolveResponseSchema,
} from '@mission-control/protocol';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Method the isolation backend selected, including the TS-side fallback. */
export type IsoMethod = 'unsupported' | 'overlayfs' | 'rcopy' | 'apfs' | 'rcopy-fallback';

/** Outcome of {@link IsoClient.resolve}. */
export interface IsoResolution {
    /** Absolute path to the independent writable worktree (empty on hard failure). */
    readonly resolved: string;
    /** Backend that produced `resolved`. */
    readonly method: IsoMethod;
    /** Set when resolve could not produce a worktree at all. */
    readonly failed: boolean;
}

/** Outcome of {@link IsoClient.diff}. */
export interface IsoDiffOutcome {
    readonly diff: string;
    readonly identical: boolean;
}

/** Raw resolve payload returned by the sidecar before method normalization. */
export interface SidecarResolvePayload {
    readonly resolved: string;
    readonly method?: string;
}

/** Raw diff payload returned by the sidecar. */
export interface SidecarDiffPayload {
    readonly diff: string;
    readonly identical: boolean;
}

/**
 * Injectable seam for the sidecar invocation. The default implementation
 * spawns the sidecar binary; tests supply a mock to exercise the fallback
 * decision logic without the binary.
 */
export interface SidecarIsoInvoker {
    resolve(target: string, method?: string): Promise<SidecarResolvePayload>;
    diff(baseline: string, current: string): Promise<SidecarDiffPayload>;
}

export class SidecarIsoError extends Error {
    public override readonly name = 'SidecarIsoError';
}

export interface IsoClientOptions {
    /** Explicit sidecar binary path; overrides workspace-root discovery. */
    readonly sidecarPath?: string;
    /** Override the sidecar invocation (tests). */
    readonly invoker?: SidecarIsoInvoker;
    /** Per-call timeout for the default sidecar invoker (default 5000ms). */
    readonly timeoutMs?: number;
}

export interface IsoClient {
    resolve(target: string, method?: string): Promise<IsoResolution>;
    diff(baseline: string, current: string): Promise<IsoDiffOutcome>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const SUPPORTED_METHODS = new Set<IsoMethod>(['overlayfs', 'rcopy', 'apfs']);

/** Create an iso client. Falls back to in-process rcopy when isolation is unsupported. */
export function createIsoClient(options: IsoClientOptions = {}): IsoClient {
    const invoker: SidecarIsoInvoker =
        options.invoker ?? defaultSidecarInvoker(options.sidecarPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return {
        async resolve(target, method) {
            return resolveWithFallback(invoker, target, method);
        },
        async diff(baseline, current) {
            const payload = await invoker.diff(baseline, current);
            return { diff: payload.diff, identical: payload.identical };
        },
    };
}

async function resolveWithFallback(
    invoker: SidecarIsoInvoker,
    target: string,
    method: string | undefined,
): Promise<IsoResolution> {
    let sidecarPayload: SidecarResolvePayload;
    try {
        sidecarPayload = await invoker.resolve(target, method);
    } catch {
        // Sidecar unavailable (binary missing, timeout, IO error). The
        // caller still needs an independent worktree, so fall back to an
        // in-process recursive copy.
        return resolveViaFallback(target);
    }

    const normalized = normalizeMethod(sidecarPayload.method);
    if (normalized === 'unsupported' || sidecarPayload.resolved.length === 0) {
        return resolveViaFallback(target);
    }
    return { resolved: sidecarPayload.resolved, method: normalized, failed: false };
}

/** In-process rcopy fallback. Produces an independent copy of `target` under the OS temp dir. */
export async function resolveViaFallback(target: string): Promise<IsoResolution> {
    try {
        const merged = await mkdtemp(join(tmpdir(), 'mctrl-iso-fallback-'));
        await cp(target, merged, { recursive: true, force: true });
        return { resolved: merged, method: 'rcopy-fallback', failed: false };
    } catch {
        return {
            resolved: '',
            method: 'rcopy-fallback',
            failed: true,
        };
    }
}

/**
 * Recursively copy `src` into a fresh `dst` directory. Exported for direct
 * testing of the fallback path. Rejects when `src` is missing or not a
 * directory.
 */
export async function copyDir(src: string, dst: string): Promise<void> {
    await mkdir(dst, { recursive: true });
    await cp(src, dst, { recursive: true, force: true });
}

function normalizeMethod(method: string | undefined): IsoMethod {
    if (method === undefined) {
        return 'rcopy';
    }
    if (SUPPORTED_METHODS.has(method as IsoMethod)) {
        return method as IsoMethod;
    }
    if (method === 'unsupported') {
        return 'unsupported';
    }
    // `failed:<reason>` and anything unrecognised is treated as unsupported so
    // the caller falls back rather than trusting a bad result.
    return 'unsupported';
}

function defaultSidecarInvoker(sidecarPath: string | undefined, timeoutMs: number): SidecarIsoInvoker {
    const resolvedPath = resolveSidecarPath(sidecarPath);
    return {
        async resolve(target, method) {
            if (resolvedPath === null) {
                throw new SidecarIsoError('sidecar binary not found; cannot resolve isolation');
            }
            const line = await runSidecarLine(
                resolvedPath,
                timeoutMs,
                (id) => ({ type: 'iso_resolve', id, payload: { target, ...(method ? { method } : {}) } }),
                'iso_resolved',
                SidecarIsoResolveResponseSchema,
            );
            return { resolved: line.payload.resolved, ...(line.payload.method ? { method: line.payload.method } : {}) };
        },
        async diff(baseline, current) {
            if (resolvedPath === null) {
                throw new SidecarIsoError('sidecar binary not found; cannot compute diff');
            }
            const line = await runSidecarLine(
                resolvedPath,
                timeoutMs,
                (id) => ({ type: 'iso_diff', id, payload: { target: baseline, baseline, current } }),
                'iso_diffed',
                SidecarIsoDiffResponseSchema,
            );
            return { diff: line.payload.diff, identical: line.payload.identical };
        },
    };
}

type IsoResolveLine = SidecarIsoResolveResponse;
type IsoDiffLine = SidecarIsoDiffResponse;

async function runSidecarLine<T extends IsoResolveLine | IsoDiffLine>(
    binaryPath: string,
    timeoutMs: number,
    buildCommand: (id: string) => unknown,
    expectedType: 'iso_resolved' | 'iso_diffed',
    schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
        const child = spawn(binaryPath, [], {
            detached: true,
            stdio: 'pipe',
            env: { ...process.env, MCTRL_SIDECAR_V3: '1' },
        });
        let buffer = '';
        let settled = false;
        const commandId = `iso_${Date.now().toString(36)}`;
        const handshakeId = `handshake_${commandId}`;
        const timeoutHandle = setTimeout(() => {
            settleReject(new SidecarIsoError(`sidecar ${expectedType} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);

        const cleanup = (): void => {
            clearTimeout(timeoutHandle);
            child.stdout.off('data', onData);
            child.stderr.off('data', onStderr);
            child.off('error', onError);
            child.off('exit', onExit);
        };
        const settleReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            try {
                if (child.pid !== undefined) {
                    process.kill(-child.pid, 'SIGTERM');
                }
            } catch {
                child.kill('SIGTERM');
            }
            rejectPromise(error);
        };
        const settleResolve = (value: T): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            try {
                if (child.pid !== undefined) {
                    process.kill(-child.pid, 'SIGTERM');
                }
            } catch {
                child.kill('SIGTERM');
            }
            resolvePromise(value);
        };

        const onData = (chunk: Buffer): void => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) {
                    continue;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }
                if (!isObjectWithDiscriminant(parsed)) {
                    continue;
                }
                if (parsed.type === 'handshake_completed') {
                    continue;
                }
                if (parsed.type === expectedType) {
                    const result = schema.safeParse(parsed);
                    if (result.success) {
                        settleResolve(result.data);
                        return;
                    }
                    settleReject(new SidecarIsoError(`sidecar ${expectedType} response failed schema validation`));
                    return;
                }
            }
        };
        const onStderr = (chunk: Buffer): void => {
            const text = chunk.toString('utf8').trim();
            if (text.length > 0) {
                settleReject(new SidecarIsoError(`sidecar stderr: ${text}`));
            }
        };
        const onError = (error: Error): void => {
            settleReject(new SidecarIsoError(`sidecar process error: ${error.message}`));
        };
        const onExit = (code: number | null): void => {
            settleReject(new SidecarIsoError(`sidecar exited before ${expectedType}: ${String(code)}`));
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onStderr);
        child.once('error', onError);
        child.once('exit', onExit);

        child.stdin.write(
            `${JSON.stringify({
                type: 'handshake',
                id: handshakeId,
                payload: {
                    protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
                    clientName: 'mission-control-iso',
                    requestedCapabilities: ['iso.resolve'],
                },
            })}\n`,
        );
        child.stdin.write(`${JSON.stringify(buildCommand(commandId))}\n`);
    });
}

function isObjectWithDiscriminant(value: unknown): value is { type: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        typeof (value as { type: unknown }).type === 'string'
    );
}

/** Resolve the sidecar binary path. Returns null when nothing is found. */
export function resolveSidecarPath(explicit?: string): string | null {
    if (explicit !== undefined && explicit.length > 0) {
        return existsSync(explicit) ? explicit : null;
    }
    const envPath = process.env['MCTRL_SIDECAR_BIN'];
    if (typeof envPath === 'string' && envPath.length > 0 && existsSync(envPath)) {
        return envPath;
    }
    for (const candidate of candidateSidecarPaths()) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function candidateSidecarPaths(): readonly string[] {
    const fromWorkspace = workspaceRootCandidates().map((root) =>
        join(root, 'native', 'sidecar', 'target', 'debug', 'mission-control-sidecar'),
    );
    const fromBinary = binaryDirCandidates().map((dir) => join(dir, 'mission-control-sidecar'));
    return [...fromWorkspace, ...fromBinary];
}

function workspaceRootCandidates(): readonly string[] {
    const fromUrl = (() => {
        try {
            return dirname(resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
        } catch {
            return null;
        }
    })();
    const cwd = process.cwd();
    return [fromUrl, cwd].filter((value): value is string => value !== null);
}

function binaryDirCandidates(): readonly string[] {
    const pathEnv = process.env['PATH'];
    if (typeof pathEnv !== 'string' || pathEnv.length === 0) {
        return [];
    }
    return pathEnv.split(':').filter((segment) => segment.length > 0);
}

/** Remove a worktree directory created by resolve. Best effort, never rejects. */
export async function removeWorktree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
}
