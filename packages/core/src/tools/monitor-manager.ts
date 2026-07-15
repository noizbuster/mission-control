// Clean-room reimplementation of a non-interactive background command monitor.
// Origin: oh-my-openagent (Sustainable Use License) monitor feature. The upstream
// is source-visible but not permissively licensed, so nothing here is copied from
// it; the background-monitor pattern (spawn a long-running command, retain its
// output in a bounded ring buffer keyed by sequence number, classify lines against
// a caller-supplied regex, enforce per-line byte caps, redact secrets, cap monitors
// per session, stop on demand) is reimplemented from scratch in mission-control's
// types and conventions. Attribution only.
//
// The manager is in-memory and owns no durable state. It collaborates with the four
// monitor_* tools (start/stop/list/output) which are config-gated on
// `monitor.enabled`. The process spawner is an injected seam so tests drive the
// lifecycle deterministically without spawning real processes; production wires the
// default `node:child_process` spawner.

import { redactCredentialText } from '../providers/credential-resolver';
import { createStreamDecoder, truncateToValidUtf8Boundary } from '../providers/stream-decoder';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type MonitorMode = 'idle' | 'live_safe';
export type MonitorStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed';
export type MonitorStream = 'stdout' | 'stderr';

export interface MonitorCounters {
    readonly totalLines: number;
    readonly matchedLines: number;
    readonly unmatchedLines: number;
    readonly droppedMatched: number;
    readonly droppedUnmatched: number;
    readonly bytesDropped: number;
    readonly lastSequence: number;
}

export interface MonitorLine {
    readonly stream: MonitorStream;
    readonly seq: number;
    readonly text: string;
    readonly matched: boolean;
    readonly truncated: boolean;
}

export interface MonitorRecord {
    readonly id: string;
    readonly label: string;
    readonly mode: MonitorMode;
    readonly parentSessionId: string;
    readonly parentMessageId?: string;
    readonly startedAt: string;
    readonly status: MonitorStatus;
    readonly exitCode: number | null;
    readonly counters: MonitorCounters;
}

export interface MonitorOutputQuery {
    readonly stream?: 'matched' | 'unmatched' | 'all';
    readonly since_sequence?: number;
    readonly limit?: number;
}

export interface MonitorOutputResult {
    readonly lines: readonly MonitorLine[];
    readonly counters: MonitorCounters;
}

export interface MonitorStartRequest {
    readonly command: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly label?: string;
    readonly mode: MonitorMode;
    readonly matchPattern?: string;
    readonly parentSessionId: string;
    readonly parentMessageId?: string;
    readonly redactionSecrets: readonly string[];
    readonly maxRuntimeMs: number;
}

export interface MonitorManagerConfig {
    readonly maxMonitorsPerSession: number;
    readonly ringMaxLines: number;
    readonly lineMaxBytes: number;
    readonly patternMaxLength: number;
}

export const DEFAULT_MONITOR_MANAGER_CONFIG: MonitorManagerConfig = {
    maxMonitorsPerSession: 3,
    ringMaxLines: 1000,
    lineMaxBytes: 8192,
    patternMaxLength: 512,
};

export interface MonitorProcessLine {
    readonly stream: MonitorStream;
    readonly text: string;
}

export interface MonitorOutputSink {
    onLine(line: MonitorProcessLine): void;
}

export interface MonitorSpawnRequest {
    readonly command: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly maxRuntimeMs: number;
}

export interface MonitorProcessHandle {
    kill(): void;
    readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
}

export interface MonitorProcessSpawner {
    spawn(request: MonitorSpawnRequest, sink: MonitorOutputSink, signal: AbortSignal): Promise<MonitorProcessHandle>;
}

export interface MonitorManagerOptions {
    readonly config?: Partial<MonitorManagerConfig>;
    readonly spawner?: MonitorProcessSpawner;
    readonly generateId?: () => string;
    readonly now?: () => number;
}

interface MutableMonitorRecord {
    id: string;
    label: string;
    mode: MonitorMode;
    parentSessionId: string;
    parentMessageId?: string;
    startedAt: string;
    status: MonitorStatus;
    exitCode: number | null;
    counters: MonitorCounters;
}

interface MonitorState {
    readonly record: MutableMonitorRecord;
    ring: MonitorLine[];
    readonly filter: RegExp | null;
    readonly controller: AbortController;
    handle: MonitorProcessHandle | null;
    counters: MonitorCounters;
    readonly redactionSecrets: readonly string[];
    readonly lineMaxBytes: number;
    readonly ringMaxLines: number;
}

function emptyCounters(): MonitorCounters {
    return {
        totalLines: 0,
        matchedLines: 0,
        unmatchedLines: 0,
        droppedMatched: 0,
        droppedUnmatched: 0,
        bytesDropped: 0,
        lastSequence: 0,
    };
}

function generateMonitorId(): string {
    return `mon_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function compileMonitorFilter(
    pattern: string | undefined,
    maxLength: number,
): { readonly filter: RegExp | null } | { readonly filter: null; readonly error: string } {
    if (pattern === undefined || pattern.length === 0) {
        return { filter: null };
    }
    if (pattern.length > maxLength) {
        return { filter: null, error: `match_pattern exceeds pattern_max_length=${maxLength}` };
    }
    try {
        return { filter: new RegExp(pattern, 'u') };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { filter: null, error: `invalid regex: ${message}` };
    }
}

export class MonitorManager {
    private readonly monitors = new Map<string, MonitorState>();
    private readonly bySession = new Map<string, Set<string>>();
    private readonly config: MonitorManagerConfig;
    private readonly spawner: MonitorProcessSpawner;
    private readonly generateId: () => string;
    private readonly now: () => number;
    private shutdownStarted = false;

    constructor(options: MonitorManagerOptions = {}) {
        this.config = { ...DEFAULT_MONITOR_MANAGER_CONFIG, ...options.config };
        this.spawner = options.spawner ?? createDefaultSpawner();
        this.generateId = options.generateId ?? generateMonitorId;
        this.now = options.now ?? (() => Date.now());
    }

    async start(input: MonitorStartRequest): Promise<MonitorRecord> {
        const filterResult = compileMonitorFilter(input.matchPattern, this.config.patternMaxLength);
        if ('error' in filterResult) {
            throw new Error(`monitor_start match_pattern rejected: ${filterResult.error}`);
        }
        this.assertSessionCapacity(input.parentSessionId);

        const id = this.generateId();
        const controller = new AbortController();
        const state: MonitorState = {
            record: {
                id,
                label: input.label ?? id,
                mode: input.mode,
                parentSessionId: input.parentSessionId,
                ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
                startedAt: new Date(this.now()).toISOString(),
                status: 'running',
                exitCode: null,
                counters: emptyCounters(),
            },
            ring: [],
            filter: filterResult.filter,
            controller,
            handle: null,
            counters: emptyCounters(),
            redactionSecrets: input.redactionSecrets,
            lineMaxBytes: this.config.lineMaxBytes,
            ringMaxLines: this.config.ringMaxLines,
        };

        this.addMonitor(state);

        const sink: MonitorOutputSink = {
            onLine: (line) => this.ingestLine(state, line),
        };
        try {
            state.handle = await this.spawner.spawn(
                {
                    command: input.command,
                    cwd: input.cwd,
                    env: input.env,
                    maxRuntimeMs: input.maxRuntimeMs,
                },
                sink,
                controller.signal,
            );
        } catch (error: unknown) {
            this.removeMonitor(id);
            state.record.status = 'failed';
            throw error;
        }

        this.watchExit(state);
        return this.snapshotRecord(state);
    }

    async stop(id: string): Promise<void> {
        const state = this.monitors.get(id);
        if (state === undefined) {
            return;
        }
        if (state.record.status === 'stopped' || state.record.status === 'exited') {
            state.record.status = 'stopped';
            return;
        }
        state.record.status = 'stopped';
        state.controller.abort();
        if (state.handle !== null) {
            try {
                state.handle.kill();
            } catch {
                // Best-effort kill; the abort signal already tore down the spawn.
            }
        }
    }

    list(sessionId: string): readonly MonitorRecord[] {
        const ids = this.bySession.get(sessionId);
        if (ids === undefined) {
            return [];
        }
        const records: MonitorRecord[] = [];
        for (const id of ids) {
            const state = this.monitors.get(id);
            if (state !== undefined) {
                records.push(this.snapshotRecord(state));
            }
        }
        return records;
    }

    get(id: string): MonitorRecord | undefined {
        const state = this.monitors.get(id);
        return state === undefined ? undefined : this.snapshotRecord(state);
    }

    getOutput(id: string, query: MonitorOutputQuery): MonitorOutputResult {
        const state = this.monitors.get(id);
        if (state === undefined) {
            return { lines: [], counters: emptyCounters() };
        }
        const stream = query.stream ?? 'all';
        const since = query.since_sequence ?? 0;
        let lines = state.ring.filter((line) => line.seq > since);
        if (stream !== 'all') {
            lines = lines.filter((line) => (stream === 'matched' ? line.matched : !line.matched));
        }
        if (query.limit !== undefined && query.limit >= 0) {
            lines = lines.slice(0, query.limit);
        }
        return { lines, counters: this.snapshotCounters(state) };
    }

    async stopSessionMonitors(sessionId: string): Promise<void> {
        const ids = [...(this.bySession.get(sessionId) ?? [])];
        await Promise.all(ids.map((id) => this.stop(id)));
    }

    async shutdown(): Promise<void> {
        if (this.shutdownStarted) {
            return;
        }
        this.shutdownStarted = true;
        const ids = [...this.monitors.keys()];
        await Promise.all(ids.map((id) => this.stop(id)));
        this.monitors.clear();
        this.bySession.clear();
    }

    private ingestLine(state: MonitorState, raw: MonitorProcessLine): void {
        if (state.record.status === 'stopped') {
            return;
        }
        const redacted = redactCredentialText(raw.text, state.redactionSecrets);
        const truncated = truncateLine(redacted, state.lineMaxBytes);
        const matched = state.filter === null ? false : state.filter.test(truncated.text);
        state.counters = {
            ...state.counters,
            lastSequence: state.counters.lastSequence + 1,
            totalLines: state.counters.totalLines + 1,
            matchedLines: state.counters.matchedLines + (matched ? 1 : 0),
            unmatchedLines: state.counters.unmatchedLines + (matched ? 0 : 1),
        };
        const line: MonitorLine = {
            stream: raw.stream,
            seq: state.counters.lastSequence,
            text: truncated.text,
            matched,
            truncated: truncated.truncated,
        };
        state.ring.push(line);
        while (state.ring.length > state.ringMaxLines) {
            const evicted = state.ring.shift();
            if (evicted === undefined) {
                break;
            }
            state.counters = {
                ...state.counters,
                droppedMatched: state.counters.droppedMatched + (evicted.matched ? 1 : 0),
                droppedUnmatched: state.counters.droppedUnmatched + (evicted.matched ? 0 : 1),
                bytesDropped: state.counters.bytesDropped + Buffer.byteLength(evicted.text, 'utf8'),
            };
        }
    }

    private watchExit(state: MonitorState): void {
        const handle = state.handle;
        if (handle === null) {
            return;
        }
        void handle.exited
            .then((outcome) => {
                if (state.record.status === 'stopped') {
                    return;
                }
                state.record.status = outcome.exitCode === 0 ? 'exited' : 'failed';
                state.record.exitCode = outcome.exitCode;
            })
            .catch(() => {
                if (state.record.status !== 'stopped') {
                    state.record.status = 'failed';
                }
            });
    }

    private assertSessionCapacity(sessionId: string): void {
        const ids = this.bySession.get(sessionId);
        if (ids === undefined) {
            return;
        }
        let active = 0;
        for (const id of ids) {
            const state = this.monitors.get(id);
            if (state !== undefined && (state.record.status === 'running' || state.record.status === 'starting')) {
                active += 1;
            }
        }
        if (active >= this.config.maxMonitorsPerSession) {
            throw new Error(
                `max_monitors_per_session reached for session ${sessionId} (cap=${this.config.maxMonitorsPerSession})`,
            );
        }
    }

    private addMonitor(state: MonitorState): void {
        this.monitors.set(state.record.id, state);
        const ids = this.bySession.get(state.record.parentSessionId) ?? new Set<string>();
        ids.add(state.record.id);
        this.bySession.set(state.record.parentSessionId, ids);
    }

    private removeMonitor(id: string): void {
        const state = this.monitors.get(id);
        if (state === undefined) {
            return;
        }
        this.monitors.delete(id);
        const ids = this.bySession.get(state.record.parentSessionId);
        if (ids === undefined) {
            return;
        }
        ids.delete(id);
        if (ids.size === 0) {
            this.bySession.delete(state.record.parentSessionId);
        }
    }

    private snapshotRecord(state: MonitorState): MonitorRecord {
        const record = state.record;
        return {
            id: record.id,
            label: record.label,
            mode: record.mode,
            parentSessionId: record.parentSessionId,
            ...(record.parentMessageId !== undefined ? { parentMessageId: record.parentMessageId } : {}),
            startedAt: record.startedAt,
            status: record.status,
            exitCode: record.exitCode,
            counters: this.snapshotCounters(state),
        };
    }

    private snapshotCounters(state: MonitorState): MonitorCounters {
        return { ...state.counters };
    }
}

type TruncatedLine = { readonly text: string; readonly truncated: boolean };

function truncateLine(text: string, maxBytes: number): TruncatedLine {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes) {
        return { text, truncated: false };
    }
    const sliced = truncateToValidUtf8Boundary(bytes, maxBytes);
    return { text: sliced.toString('utf8'), truncated: true };
}

/**
 * Default production spawner. Runs the command non-interactively via
 * `node:child_process` with piped stdio, a max-runtime timeout, and line-aware
 * stdout/stderr framing. The abort signal tears the child down promptly. Tests
 * inject a fake spawner instead so the lifecycle is deterministic.
 */
export function createDefaultSpawner(): MonitorProcessSpawner {
    return {
        spawn(request, sink, signal) {
            return new Promise<MonitorProcessHandle>((resolve) => {
                const child = spawn(request.command, {
                    cwd: request.cwd,
                    env: request.env,
                    shell: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let exitedResolve: (outcome: { exitCode: number | null; signal: string | null }) => void;
                const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolveExit) => {
                    exitedResolve = resolveExit;
                });
                let stdoutBuf = '';
                let stderrBuf = '';
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                let settled = false;
                const stdoutDecoder = createStreamDecoder();
                const stderrDecoder = createStreamDecoder();

                const teardown = (exitCode: number | null, signal: string | null): void => {
                    if (settled) return;
                    settled = true;
                    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                    flushRemaining(stdoutBuf, 'stdout', sink);
                    flushRemaining(stderrBuf, 'stderr', sink);
                    exitedResolve({ exitCode, signal });
                };

                if (request.maxRuntimeMs > 0) {
                    timeoutHandle = setTimeout(() => {
                        try {
                            child.kill('SIGTERM');
                        } catch {
                            // ignore
                        }
                    }, request.maxRuntimeMs);
                }

                child.stdout?.on('data', (chunk: Buffer) => {
                    const [remaining, lines] = splitLines(stdoutBuf + stdoutDecoder.decode(chunk));
                    stdoutBuf = remaining;
                    for (const line of lines) sink.onLine({ stream: 'stdout', text: line });
                });
                child.stderr?.on('data', (chunk: Buffer) => {
                    const [remaining, lines] = splitLines(stderrBuf + stderrDecoder.decode(chunk));
                    stderrBuf = remaining;
                    for (const line of lines) sink.onLine({ stream: 'stderr', text: line });
                });
                child.on('error', (error) => {
                    sink.onLine({ stream: 'stderr', text: `spawn error: ${error.message}` });
                    teardown(1, null);
                });
                child.on('close', (code, signal) => {
                    teardown(code, signal);
                });

                const abort = (): void => {
                    try {
                        child.kill('SIGTERM');
                    } catch {
                        // ignore
                    }
                };
                if (signal.aborted) {
                    abort();
                } else {
                    signal.addEventListener('abort', abort, { once: true });
                }

                resolve({
                    kill: abort,
                    exited,
                });
            });
        },
    };
}

function splitLines(buffered: string): [string, string[]] {
    const lines: string[] = [];
    let cursor = 0;
    for (let index = 0; index < buffered.length; index += 1) {
        if (buffered[index] === '\n') {
            lines.push(buffered.slice(cursor, index));
            cursor = index + 1;
        }
    }
    const remaining = buffered.slice(cursor);
    return [remaining, lines];
}

function flushRemaining(remaining: string, stream: MonitorStream, sink: MonitorOutputSink): void {
    if (remaining.length === 0) return;
    sink.onLine({ stream, text: remaining });
}
