import type { PermissionDecision, PermissionRequest, SidecarStreamFrame } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShellSessionTransport, ShellSessionTransportRequest } from './shell-session.js';
import { registerShellSessionTool } from './shell-session.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

/**
 * Stateful in-memory transport. It simulates the sidecar v3 shell.session
 * capability: env exports in one call persist to the next, mirroring the Rust
 * brush handler. Captures every received request so containment can be
 * asserted on what crossed the wire.
 */
type StatefulTransportOptions = {
    readonly delayMs?: number;
};

class StatefulShellTransport implements ShellSessionTransport {
    readonly received: ShellSessionTransportRequest[] = [];
    private readonly exported = new Map<string, string>();
    private readonly delayMs: number;

    constructor(options: StatefulTransportOptions = {}) {
        this.delayMs = options.delayMs ?? 0;
    }

    async openSession(request: ShellSessionTransportRequest): Promise<readonly SidecarStreamFrame[]> {
        this.received.push(request);
        if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        this.applyExports(request.command);
        const output = this.evaluate(request.command);
        return this.frames(output);
    }

    private applyExports(command: string): void {
        const exportMatch = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(command.trim());
        if (exportMatch) {
            const name = exportMatch[1];
            const rawValue = exportMatch[2];
            if (name !== undefined && rawValue !== undefined) {
                this.exported.set(name, rawValue.replace(/^['"]|['"]$/gu, ''));
            }
        }
    }

    private evaluate(command: string): string {
        const trimmed = command.trim();
        const echoMatch = /^echo\s+(.*)$/u.exec(trimmed);
        if (echoMatch) {
            const operand = echoMatch[1];
            if (operand !== undefined) {
                return this.expand(operand);
            }
        }
        return '';
    }

    private expand(token: string): string {
        const replaced = token.replace(
            /"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?/gu,
            (whole, name: string) => this.exported.get(name) ?? whole,
        );
        return `${replaced}\n`;
    }

    private frames(output: string): readonly SidecarStreamFrame[] {
        if (output.length === 0) {
            return [{ sessionId: 'test', seq: 0, payload: '', end: true }];
        }
        return [
            { sessionId: 'test', seq: 0, payload: output, end: false },
            { sessionId: 'test', seq: 1, payload: '', end: true },
        ];
    }
}

describe('shell.session tool', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('persists environment across two calls in one session', async () => {
        const transport = new StatefulShellTransport();
        const registry = await createRegistry({ transport });

        const first = await invoke(registry, { commandLine: 'export MCTRL_PERSIST=1' });
        const second = await invoke(registry, { commandLine: 'echo ${MCTRL_PERSIST}' });

        expect(first.result.status).toBe('completed');
        expect(second.result.status).toBe('completed');
        const firstStructured = first.structuredOutput as { sessionId: string };
        const secondStructured = second.structuredOutput as { sessionId: string; stdout: string };
        expect(secondStructured.sessionId).toBe(firstStructured.sessionId);
        expect(secondStructured.stdout).toContain('1');
        expect(transport.received.map((r) => r.command)).toEqual(['export MCTRL_PERSIST=1', 'echo ${MCTRL_PERSIST}']);
    });

    it('caps output above the 64KB limit and signals truncation', async () => {
        const oversize = 'x'.repeat(4_000);
        const transport = new StatefulShellTransport();
        const registry = await createRegistry({
            transport,
            maxOutputBytes: 8,
        });

        const settlement = await invokeRaw(registry, {
            commandLine: `echo ${oversize}`,
        });

        const structured = settlement.structuredOutput as {
            stdout: string;
            truncated: boolean;
            returnedBytes: number;
            originalBytes: number;
        };
        expect(settlement.result.status).toBe('completed');
        expect(structured.truncated).toBe(true);
        expect(structured.returnedBytes).toBe(8);
        expect(structured.originalBytes).toBeGreaterThan(8);
        expect(settlement.modelOutput?.content ?? '').toContain('truncated');
    });

    it('redacts allowlisted secret env values from output, model output, and events', async () => {
        const envSecret = 'plain-shell-secret';
        const transport = new StatefulShellTransport();
        const registry = await createRegistry({
            transport,
            envAllowlist: ['PATH', 'SAFE_SECRET'],
            hostEnv: {
                PATH: '/usr/bin',
                SAFE_SECRET: envSecret,
            },
        });

        const settlement = await invoke(registry, { commandLine: `echo ${envSecret}` });

        const structured = JSON.stringify(settlement.structuredOutput);
        const model = settlement.modelOutput?.content ?? '';
        const events = JSON.stringify(settlement.events);
        expect(structured).not.toContain(envSecret);
        expect(model).not.toContain(envSecret);
        expect(events).not.toContain(envSecret);
    });

    it('rejects cwd escapes before contacting the transport', async () => {
        const transport = new StatefulShellTransport();
        const workspaceRoot = await tempRoot('mctrl-shell-cwd-');
        const outside = await tempRoot('mctrl-shell-outside-');
        const registry = await createRegistry({ transport, workspaceRoot });

        const settlement = await invoke(registry, { commandLine: 'echo ok', cwd: outside });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('cwd');
        expect(transport.received).toEqual([]);
    });

    it('denies unknown-trust workspaces before approval or transport', async () => {
        const transport = new StatefulShellTransport();
        const registry = await createRegistry({ transport, workspaceTrust: 'unknown' });

        const settlement = await invoke(registry, { commandLine: 'echo ok' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('trusted workspace');
        expect(transport.received).toEqual([]);
    });

    it('fires the 30s timeout for a hung command and records a typed timeout event', async () => {
        const transport = new StatefulShellTransport({ delayMs: 200 });
        const registry = await createRegistry({ transport, timeoutMs: 40 });

        const settlement = await invoke(registry, { commandLine: 'echo late' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_timed_out');
        expect(settlement.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.timed_out', 'tool.failed']),
        );
    });

    it('enforces single-invocation concurrency per session', async () => {
        const release = createDeferred<readonly SidecarStreamFrame[]>();
        const receivedByBlocker: ShellSessionTransportRequest[] = [];
        const blockingTransport: ShellSessionTransport = {
            openSession: (request) => {
                receivedByBlocker.push(request);
                return release.promise;
            },
        };
        const registry = await createRegistry({ transport: blockingTransport });

        const first = invoke(registry, { commandLine: 'echo first', sessionId: 'concurrent' });
        await waitFor(() => receivedByBlocker.length === 1);
        const second = await invoke(registry, { commandLine: 'echo second', sessionId: 'concurrent' });
        release.resolve([
            { sessionId: 'concurrent', seq: 0, payload: 'first\n', end: false },
            { sessionId: 'concurrent', seq: 1, payload: '', end: true },
        ]);
        const firstSettlement = await first;

        expect(firstSettlement.result.status).toBe('completed');
        expect(second.result.status).toBe('failed');
        expect(second.result.error?.message).toContain('concurrency_limit');
    });

    it('does not spawn a process when approval is denied', async () => {
        const transport = new StatefulShellTransport();
        const registry = await createRegistry({
            transport,
            requestPermission: denyPermission,
        });

        const settlement = await invoke(registry, { commandLine: 'echo ok' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_denied');
        expect(transport.received).toEqual([]);
    });
});

type CreateRegistryInput = {
    readonly workspaceRoot?: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision;
    readonly transport: ShellSessionTransport;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly envAllowlist?: readonly string[];
    readonly hostEnv?: NodeJS.ProcessEnv;
};

async function createRegistry(input: CreateRegistryInput): Promise<ToolRegistry> {
    const workspaceRoot = input.workspaceRoot ?? (await tempRoot('mctrl-shell-session-'));
    const registry = new ToolRegistry();
    await registerShellSessionTool(registry, {
        workspaceRoot,
        workspaceTrust: input.workspaceTrust ?? 'trusted',
        requestPermission: input.requestPermission ?? allowPermission,
        transport: input.transport,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        ...(input.envAllowlist !== undefined ? { envAllowlist: input.envAllowlist } : {}),
        ...(input.hostEnv !== undefined ? { hostEnv: input.hostEnv } : {}),
        generateSessionId: () => 'test-session-id',
    });
    return registry;
}

async function invoke(
    registry: ToolRegistry,
    input: { readonly commandLine: string; readonly cwd?: string; readonly sessionId?: string },
): Promise<ToolInvocationSettlement> {
    return invokeRaw(registry, input);
}

async function invokeRaw(
    registry: ToolRegistry,
    input: { readonly commandLine: string; readonly cwd?: string; readonly sessionId?: string },
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'shell.session');
    if (advertisement === undefined) {
        throw new TypeError('missing shell.session advertisement');
    }
    return registry.invoke({
        toolCallId: 'shell_call',
        toolName: 'shell.session',
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

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}

function createDeferred<Value>() {
    let resolveFn: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((resolve) => {
        resolveFn = resolve;
    });
    return { promise, resolve: resolveFn };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
