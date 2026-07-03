// TDD coverage for the four monitor_* tools plus the MonitorManager they share.
// Scenarios: start→list→output→stop lifecycle; match-triggered line classification;
// ring-buffer cap eviction + per-line byte truncation; secret redaction in retained
// output; cross-session denial; config-off → all four tools return null (absent).
//
// A fake spawner emits scripted lines deterministically so no real process is spawned.

import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonitorListToolRegistration, type MonitorListOutput } from './monitor-list-tool.js';
import {
    DEFAULT_MONITOR_MANAGER_CONFIG,
    MonitorManager,
    type MonitorManagerOptions,
    type MonitorOutputSink,
    type MonitorProcessHandle,
    type MonitorProcessLine,
    type MonitorProcessSpawner,
    type MonitorSpawnRequest,
} from './monitor-manager.js';
import { createMonitorOutputToolRegistration, type MonitorOutputOutput } from './monitor-output-tool.js';
import {
    createMonitorStartToolRegistration,
    DEFAULT_MONITOR_TOOLS_CONFIG,
    type MonitorStartOutput,
    type MonitorToolsConfig,
} from './monitor-start-tool.js';
import { createMonitorStopToolRegistration, type MonitorStopOutput } from './monitor-stop-tool.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

type FakeHandleControls = {
    readonly emit: (line: MonitorProcessLine) => void;
    readonly exit: (exitCode: number | null, signal?: string | null) => void;
    readonly killCalls: number;
};

interface FakeSpawnerOptions {
    readonly onSpawn?: (request: MonitorSpawnRequest) => void;
}

function createFakeSpawner(options: FakeSpawnerOptions = {}): {
    readonly spawner: MonitorProcessSpawner;
    readonly handles: ReadonlyMap<string, FakeHandleControls>;
} {
    const handles = new Map<string, FakeHandleControls>();
    const spawner: MonitorProcessSpawner = {
        spawn(request, sink, signal) {
            options.onSpawn?.(request);
            const monitorId = `fake_${Math.random().toString(36).slice(2, 8)}`;
            let exitedResolve!: (outcome: { exitCode: number | null; signal: string | null }) => void;
            const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
                exitedResolve = resolve;
            });
            let killCalls = 0;
            const controls: FakeHandleControls = {
                emit(line) {
                    sink.onLine(line);
                },
                exit(exitCode, signal = null) {
                    exitedResolve({ exitCode, signal });
                },
                get killCalls() {
                    return killCalls;
                },
            };
            handles.set(monitorId, controls);
            const handle: MonitorProcessHandle = {
                kill() {
                    killCalls += 1;
                },
                exited,
            };
            signal.addEventListener('abort', () => exitedResolve({ exitCode: null, signal: 'SIGTERM' }), {
                once: true,
            });
            return Promise.resolve(handle);
        },
    };
    return { spawner, handles };
}

const enabledConfig: MonitorToolsConfig = {
    enabled: true,
    liveModeEnabled: false,
    maxMonitorsPerSession: DEFAULT_MONITOR_TOOLS_CONFIG.maxMonitorsPerSession,
    maxRuntimeMs: DEFAULT_MONITOR_TOOLS_CONFIG.maxRuntimeMs,
};

const disabledConfig: MonitorToolsConfig = { ...enabledConfig, enabled: false };

describe('monitor_* tools config gating', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('returns null for all four tools when config.enabled is false', async () => {
        const root = await tempRoot();
        const manager = new MonitorManager();
        const shared = { manager, config: disabledConfig, sessionId: 'ses_a' };

        const start = await createMonitorStartToolRegistration({
            ...shared,
            workspaceRoot: root,
            workspaceTrust: 'trusted',
            requestPermission: allowPermission,
        });
        const stop = await createMonitorStopToolRegistration(shared);
        const list = await createMonitorListToolRegistration(shared);
        const output = await createMonitorOutputToolRegistration(shared);

        expect(start).toBeNull();
        expect(stop).toBeNull();
        expect(list).toBeNull();
        expect(output).toBeNull();
    });

    it('returns non-null registrations for all four tools when config.enabled is true', async () => {
        const root = await tempRoot();
        const manager = new MonitorManager();
        const shared = { manager, config: enabledConfig, sessionId: 'ses_a' };

        const start = await createMonitorStartToolRegistration({
            ...shared,
            workspaceRoot: root,
            workspaceTrust: 'trusted',
            requestPermission: allowPermission,
        });
        const stop = await createMonitorStopToolRegistration(shared);
        const list = await createMonitorListToolRegistration(shared);
        const output = await createMonitorOutputToolRegistration(shared);

        expect(start?.name).toBe('monitor_start');
        expect(stop?.name).toBe('monitor_stop');
        expect(list?.name).toBe('monitor_list');
        expect(output?.name).toBe('monitor_output');
    });
});

describe('monitor_* lifecycle (start → list → output → stop)', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('starts a monitor, lists it, reads matched output, and stops it', async () => {
        const root = await tempRoot();
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({ spawner, config: { ringMaxLines: 16, lineMaxBytes: 1024 } });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const startSettlement = await invokeStart(registry, {
            command: 'echo hello',
            label: 'greeter',
            match_pattern: 'hello',
        });
        expect(startSettlement.result.status).toBe('completed');
        const startOutput = startSettlement.structuredOutput as MonitorStartOutput;
        expect(startOutput.kind).toBe('monitor_start');
        expect(startOutput.label).toBe('greeter');
        expect(startOutput.mode).toBe('idle');
        expect(startOutput.denied).toBe(false);

        const monitorId = startOutput.monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: 'hello world' });
        handle.emit({ stream: 'stdout', text: 'silent line' });

        const listSettlement = await invokeList(registry, {});
        const listOutput = listSettlement.structuredOutput as MonitorListOutput;
        expect(listOutput.monitors).toHaveLength(1);
        expect(listOutput.monitors[0]?.id).toBe(monitorId);
        expect(listOutput.monitors[0]?.label).toBe('greeter');
        expect(listOutput.monitors[0]?.counters.matchedLines).toBe(1);
        expect(listOutput.monitors[0]?.counters.unmatchedLines).toBe(1);

        const outputSettlement = await invokeOutput(registry, { monitor_id: monitorId, stream: 'matched' });
        const outputOutput = outputSettlement.structuredOutput as MonitorOutputOutput;
        expect(outputOutput.lines.map((line) => line.text)).toEqual(['hello world']);
        expect(outputOutput.lines.every((line) => line.matched)).toBe(true);

        const stopSettlement = await invokeStop(registry, { monitor_id: monitorId });
        const stopOutput = stopSettlement.structuredOutput as MonitorStopOutput;
        expect(stopOutput.status).toBe('stopped');

        const listAfterStop = (await invokeList(registry, {})).structuredOutput as MonitorListOutput;
        expect(listAfterStop.monitors).toHaveLength(0);

        const listWithExited = (await invokeList(registry, { include_exited: true }))
            .structuredOutput as MonitorListOutput;
        expect(listWithExited.monitors).toHaveLength(1);
        expect(listWithExited.monitors[0]?.status).toBe('stopped');

        await manager.shutdown();
    });

    it('coerces live_safe to idle with a note when live_mode_enabled is false', async () => {
        const root = await tempRoot();
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const registry = await buildRegistry({
            manager,
            config: { ...enabledConfig, liveModeEnabled: false },
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const settlement = await invokeStart(registry, {
            command: 'echo x',
            label: 'live-attempt',
            mode: 'live_safe',
        });
        const output = settlement.structuredOutput as MonitorStartOutput;
        expect(output.mode).toBe('idle');
        expect(output.note).toContain('coerced');
        await manager.shutdown();
    });

    it('preserves live_safe when live_mode_enabled is true', async () => {
        const root = await tempRoot();
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const registry = await buildRegistry({
            manager,
            config: { ...enabledConfig, liveModeEnabled: true },
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const settlement = await invokeStart(registry, {
            command: 'echo x',
            label: 'live-ok',
            mode: 'live_safe',
        });
        const output = settlement.structuredOutput as MonitorStartOutput;
        expect(output.mode).toBe('live_safe');
        expect(output.note).toBeNull();
        await manager.shutdown();
    });
});

describe('monitor_* match-triggered classification', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('classifies lines by the match_pattern and serves each stream view', async () => {
        const root = await tempRoot();
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({ spawner, config: { ringMaxLines: 32, lineMaxBytes: 1024 } });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const startSettlement = await invokeStart(registry, {
            command: 'test runner',
            label: 'tests',
            match_pattern: 'ERROR|FAIL',
        });
        const monitorId = (startSettlement.structuredOutput as MonitorStartOutput).monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: 'OK passing' });
        handle.emit({ stream: 'stderr', text: 'ERROR boom' });
        handle.emit({ stream: 'stdout', text: 'FAIL assertion' });
        handle.emit({ stream: 'stdout', text: 'OK done' });

        const matched = (await invokeOutput(registry, { monitor_id: monitorId, stream: 'matched' }))
            .structuredOutput as MonitorOutputOutput;
        expect(matched.lines.map((line) => line.text).sort()).toEqual(['ERROR boom', 'FAIL assertion']);

        const unmatched = (await invokeOutput(registry, { monitor_id: monitorId, stream: 'unmatched' }))
            .structuredOutput as MonitorOutputOutput;
        expect(unmatched.lines.map((line) => line.text)).toEqual(['OK passing', 'OK done']);

        const all = (await invokeOutput(registry, { monitor_id: monitorId, stream: 'all' }))
            .structuredOutput as MonitorOutputOutput;
        expect(all.lines).toHaveLength(4);
        expect(all.counters.matchedLines).toBe(2);
        expect(all.counters.unmatchedLines).toBe(2);
        await manager.shutdown();
    });

    it('rejects an invalid match_pattern without starting a monitor', async () => {
        const root = await tempRoot();
        const manager = new MonitorManager();
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });
        const settlement = await invokeStart(registry, {
            command: 'echo x',
            label: 'bad-pattern',
            match_pattern: '[',
        });
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('match_pattern');
        await manager.shutdown();
    });
});

describe('monitor_* caps and redaction', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('evicts oldest lines past the ring cap and surfaces dropped counters', async () => {
        const root = await tempRoot();
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({
            spawner,
            config: { ringMaxLines: 3, lineMaxBytes: 1024, maxMonitorsPerSession: 2 },
        });
        const registry = await buildRegistry({
            manager,
            config: { ...enabledConfig, maxMonitorsPerSession: 2 },
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const startSettlement = await invokeStart(registry, { command: 'spinner', label: 'cap' });
        const monitorId = (startSettlement.structuredOutput as MonitorStartOutput).monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: 'line-1' });
        handle.emit({ stream: 'stdout', text: 'line-2' });
        handle.emit({ stream: 'stdout', text: 'line-3' });
        handle.emit({ stream: 'stdout', text: 'line-4' });
        handle.emit({ stream: 'stdout', text: 'line-5' });

        const output = (await invokeOutput(registry, { monitor_id: monitorId }))
            .structuredOutput as MonitorOutputOutput;
        expect(output.lines.map((line) => line.text)).toEqual(['line-3', 'line-4', 'line-5']);
        expect(output.counters.totalLines).toBe(5);
        expect(output.counters.droppedUnmatched).toBe(2);
        expect(output.counters.bytesDropped).toBe(
            Buffer.byteLength('line-1', 'utf8') + Buffer.byteLength('line-2', 'utf8'),
        );
        await manager.shutdown();
    });

    it('truncates individual lines past the byte cap and flags them truncated', async () => {
        const root = await tempRoot();
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({
            spawner,
            config: { ringMaxLines: 8, lineMaxBytes: 4, patternMaxLength: 64 },
        });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        const startSettlement = await invokeStart(registry, { command: 'noise', label: 'trunc' });
        const monitorId = (startSettlement.structuredOutput as MonitorStartOutput).monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: 'abcdefgh' });

        const output = (await invokeOutput(registry, { monitor_id: monitorId }))
            .structuredOutput as MonitorOutputOutput;
        expect(output.lines).toHaveLength(1);
        expect(output.lines[0]?.text).toBe('abcd');
        expect(output.lines[0]?.truncated).toBe(true);
        await manager.shutdown();
    });

    it('redacts secret values from retained output', async () => {
        const root = await tempRoot();
        // Seed an env var so buildTrustedBashEnv classifies it as a secret.
        const secretValue = 'SUPER_SECRET_VALUE_42';
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({ spawner, config: { ringMaxLines: 8, lineMaxBytes: 1024 } });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
            hostEnv: { ...process.env, MCTRL_TEST_TOKEN: secretValue },
            envAllowlist: [...defaultBashEnvAllowlist(), 'MCTRL_TEST_TOKEN'],
        });

        const startSettlement = await invokeStart(registry, { command: 'leak', label: 'leak' });
        const monitorId = (startSettlement.structuredOutput as MonitorStartOutput).monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: `token=${secretValue}` });

        const output = (await invokeOutput(registry, { monitor_id: monitorId }))
            .structuredOutput as MonitorOutputOutput;
        expect(output.lines[0]?.text).not.toContain(secretValue);
        await manager.shutdown();
    });

    it('enforces the per-session monitor cap by failing the fourth start', async () => {
        const root = await tempRoot();
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner, config: { maxMonitorsPerSession: 2, ringMaxLines: 4 } });
        const registry = await buildRegistry({
            manager,
            config: { ...enabledConfig, maxMonitorsPerSession: 2 },
            workspaceRoot: root,
            sessionId: 'ses_a',
        });

        await invokeStart(registry, { command: 'a', label: 'a' });
        await invokeStart(registry, { command: 'b', label: 'b' });
        const third = await invokeStart(registry, { command: 'c', label: 'c' });
        expect(third.result.status).toBe('failed');
        expect(third.result.error?.message).toContain('max_monitors_per_session');
        await manager.shutdown();
    });
});

describe('monitor_* cross-session isolation', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('denies stop and returns not_found for output on a monitor owned by another session', async () => {
        const root = await tempRoot();
        const { spawner, handles } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const ownerRegistry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_owner',
        });
        const intruderRegistry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_intruder',
        });

        const startSettlement = await invokeStart(ownerRegistry, { command: 'owner-only', label: 'private' });
        const monitorId = (startSettlement.structuredOutput as MonitorStartOutput).monitorId;
        const handle = firstHandle(handles);
        handle.emit({ stream: 'stdout', text: 'private line' });

        const stopFromIntruder = await invokeStop(intruderRegistry, { monitor_id: monitorId });
        expect((stopFromIntruder.structuredOutput as MonitorStopOutput).status).toBe('denied');

        const outputFromIntruder = await invokeOutput(intruderRegistry, { monitor_id: monitorId });
        expect((outputFromIntruder.structuredOutput as MonitorOutputOutput).error).toBe('not_found');

        // The owner can still see and stop it.
        const ownerOutput = (await invokeOutput(ownerRegistry, { monitor_id: monitorId }))
            .structuredOutput as MonitorOutputOutput;
        expect(ownerOutput.lines.map((line) => line.text)).toEqual(['private line']);
        const ownerStop = (await invokeStop(ownerRegistry, { monitor_id: monitorId }))
            .structuredOutput as MonitorStopOutput;
        expect(ownerStop.status).toBe('stopped');
        await manager.shutdown();
    });

    it('returns already-stopped for an unknown monitor id', async () => {
        const root = await tempRoot();
        const manager = new MonitorManager();
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });
        const stop = await invokeStop(registry, { monitor_id: 'mon_does_not_exist' });
        expect((stop.structuredOutput as MonitorStopOutput).status).toBe('already-stopped');
        await manager.shutdown();
    });
});

describe('monitor_* permission + trust gating', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('fails monitor_start when the bash permission denies', async () => {
        const root = await tempRoot();
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
            requestPermission: denyPermission,
        });
        const settlement = await invokeStart(registry, { command: 'echo x', label: 'denied' });
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval');
        await manager.shutdown();
    });

    it('fails monitor_start when the workspace is not trusted', async () => {
        const root = await tempRoot();
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            workspaceTrust: 'denied',
            sessionId: 'ses_a',
        });
        const settlement = await invokeStart(registry, { command: 'echo x', label: 'untrusted' });
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('trusted');
        await manager.shutdown();
    });

    it('never echoes the raw command in the start model output', async () => {
        const root = await tempRoot();
        const secretCommand = 'echo SECRET_COMMAND_MARKER_99';
        const { spawner } = createFakeSpawner();
        const manager = new MonitorManager({ spawner });
        const registry = await buildRegistry({
            manager,
            config: enabledConfig,
            workspaceRoot: root,
            sessionId: 'ses_a',
        });
        const settlement = await invokeStart(registry, { command: secretCommand, label: 'safe-label' });
        expect(settlement.modelOutput).toBeDefined();
        const modelText = settlement.modelOutput?.content ?? '';
        expect(modelText).not.toContain('SECRET_COMMAND_MARKER_99');
        expect(modelText).toContain('safe-label');
        await manager.shutdown();
    });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type BuildRegistryInput = {
    readonly manager: MonitorManager;
    readonly config: MonitorToolsConfig;
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision;
    readonly hostEnv?: NodeJS.ProcessEnv;
    readonly envAllowlist?: readonly string[];
};

async function buildRegistry(input: BuildRegistryInput): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const startReg = await createMonitorStartToolRegistration({
        manager: input.manager,
        config: input.config,
        workspaceRoot: await realpath(input.workspaceRoot),
        workspaceTrust: input.workspaceTrust ?? 'trusted',
        requestPermission: input.requestPermission ?? allowPermission,
        sessionId: input.sessionId,
        ...(input.hostEnv !== undefined ? { hostEnv: input.hostEnv } : {}),
        ...(input.envAllowlist !== undefined ? { envAllowlist: input.envAllowlist } : {}),
    });
    if (startReg === null) {
        throw new TypeError('monitor_start registration was null; config.enabled must be true');
    }
    registry.register(startReg);
    const shared = { manager: input.manager, config: input.config, sessionId: input.sessionId };
    const stopReg = await createMonitorStopToolRegistration(shared);
    const listReg = await createMonitorListToolRegistration(shared);
    const outputReg = await createMonitorOutputToolRegistration(shared);
    if (stopReg === null || listReg === null || outputReg === null) {
        throw new TypeError('monitor_* registration was null; config.enabled must be true');
    }
    registry.register(stopReg);
    registry.register(listReg);
    registry.register(outputReg);
    return registry;
}

async function invokeStart(
    registry: ToolRegistry,
    input: {
        readonly command: string;
        readonly label?: string;
        readonly mode?: 'idle' | 'live_safe';
        readonly match_pattern?: string;
    },
): Promise<ToolInvocationSettlement & { readonly structuredOutput: MonitorStartOutput }> {
    return invoke(registry, 'monitor_start', input) as Promise<
        ToolInvocationSettlement & { readonly structuredOutput: MonitorStartOutput }
    >;
}

async function invokeStop(
    registry: ToolRegistry,
    input: { readonly monitor_id: string },
): Promise<ToolInvocationSettlement & { readonly structuredOutput: MonitorStopOutput }> {
    return invoke(registry, 'monitor_stop', input) as Promise<
        ToolInvocationSettlement & { readonly structuredOutput: MonitorStopOutput }
    >;
}

async function invokeList(
    registry: ToolRegistry,
    input: { readonly include_exited?: boolean },
): Promise<ToolInvocationSettlement & { readonly structuredOutput: MonitorListOutput }> {
    return invoke(registry, 'monitor_list', input) as Promise<
        ToolInvocationSettlement & { readonly structuredOutput: MonitorListOutput }
    >;
}

async function invokeOutput(
    registry: ToolRegistry,
    input: {
        readonly monitor_id: string;
        readonly stream?: 'matched' | 'unmatched' | 'all';
        readonly since_sequence?: number;
        readonly limit?: number;
    },
): Promise<ToolInvocationSettlement & { readonly structuredOutput: MonitorOutputOutput }> {
    return invoke(registry, 'monitor_output', input) as Promise<
        ToolInvocationSettlement & { readonly structuredOutput: MonitorOutputOutput }
    >;
}

async function invoke(
    registry: ToolRegistry,
    toolName: string,
    input: Record<string, unknown>,
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === toolName);
    if (advertisement === undefined) {
        throw new TypeError(`missing ${toolName} advertisement`);
    }
    return registry.invoke({
        toolCallId: `${toolName}_call`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

function defaultBashEnvAllowlist(): readonly string[] {
    return [
        'HOME',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'LOGNAME',
        'PATH',
        'SHELL',
        'TEMP',
        'TERM',
        'TMP',
        'TMPDIR',
        'USER',
        'USERNAME',
    ];
}

function firstHandle(handles: ReadonlyMap<string, FakeHandleControls>): FakeHandleControls {
    const first = handles.values().next();
    if (first.done === true || first.value === undefined) {
        throw new TypeError('no fake spawner handle was recorded; spawn was not called');
    }
    return first.value;
}

async function tempRoot(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'mctrl-monitor-'));
    tempRoots.push(path);
    // Touch a placeholder file so realpath + trust checks have a concrete workspace.
    await writeFile(join(path, '.workspace'), 'monitor test workspace');
    return path;
}

// Re-exported so the type-checker keeps the symbol anchored to this file's expectations.
export type { MonitorManagerOptions, MonitorOutputSink, MonitorProcessLine };
export { DEFAULT_MONITOR_MANAGER_CONFIG };
