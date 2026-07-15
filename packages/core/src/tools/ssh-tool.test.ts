import type { PermissionDecision, SidecarStreamFrame } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createSshToolRegistration, registerSshTool, type SshInput, type SshToolOptions } from './ssh-tool';
import { ToolRegistry } from './tool-registry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ssh-tool-test-'));
    tempDirs.push(dir);
    return dir;
}

function allowAll(): (request: { readonly id: string }) => Promise<PermissionDecision> {
    return async () => ({ requestId: 'r', status: 'allow' });
}

function mockTransport(
    frames: readonly SidecarStreamFrame[],
    capture?: (command: string) => void,
): { readonly transport: SshToolOptions['transport']; readonly calls: string[] } {
    const calls: string[] = [];
    return {
        transport: {
            allocPty: async (request) => {
                const command = request.command ?? '';
                calls.push(command);
                capture?.(command);
                return frames;
            },
        },
        calls,
    };
}

function singleFrame(payload: string, end = true, error?: string, sessionId = 'sess-1'): SidecarStreamFrame {
    return { sessionId, seq: 0, payload, end, ...(error !== undefined ? { error } : {}) };
}

function toolContext() {
    return { toolCallId: 'tc1', toolName: 'ssh', signal: new AbortController().signal };
}

describe('ssh tool', () => {
    afterEach(async () => {
        const dirs = tempDirs.splice(0, tempDirs.length);
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('returns null registration when no hosts are configured (config-gated)', async () => {
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [],
            transport: mockTransport([]).transport,
            requestPermission: allowAll(),
        });
        expect(registration).toBeNull();
    });

    it('refuses on an untrusted workspace', async () => {
        const { transport } = mockTransport([singleFrame('hello')]);
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'denied',
            hosts: [{ name: 'prod', host: 'prod.example' }],
            transport,
            requestPermission: allowAll(),
        });
        expect(registration).not.toBeNull();
        const input: SshInput = { host: 'prod', command: 'uname -a' };
        await expect(registration?.execute(input, toolContext())).rejects.toThrow(/trust/i);
    });

    it('errors when the requested host is not configured', async () => {
        const { transport } = mockTransport([singleFrame('hello')]);
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example' }],
            transport,
            requestPermission: allowAll(),
        });
        await expect(registration?.execute({ host: 'staging', command: 'uptime' }, toolContext())).rejects.toThrow(
            /not configured/,
        );
    });

    it('runs a remote command via the pty transport and returns assembled output', async () => {
        const { transport, calls } = mockTransport([singleFrame('Linux box 6.1.0\n')]);
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example', username: 'deploy', port: 2222 }],
            transport,
            requestPermission: allowAll(),
        });
        expect(registration).not.toBeNull();
        const output = await registration?.execute({ host: 'prod', command: 'uname -a' }, toolContext());
        expect(output).toBeDefined();
        expect(output?.status).toBe('completed');
        expect(output?.output).toContain('Linux box');
        expect(output?.exitCode).toBe(0);
        expect(output?.host).toBe('prod');
        expect(calls.length).toBe(1);
        expect(calls[0]).toContain('ssh');
        expect(calls[0]).toContain('deploy@prod.example');
        expect(calls[0]).toContain('-p 2222');
        expect(calls[0]).toContain("'uname -a'");
    });

    it('reports a nonzero exit code as failed', async () => {
        const { transport } = mockTransport([singleFrame('boom\n', true, 'nonzero_exit:2')]);
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example' }],
            transport,
            requestPermission: allowAll(),
        });
        const output = await registration?.execute({ host: 'prod', command: 'false' }, toolContext());
        expect(output?.status).toBe('failed');
        expect(output?.exitCode).toBe(2);
    });

    it('redacts the configured key path from model output', async () => {
        const keyPath = '/super/secret/id_rsa';
        const { transport } = mockTransport([singleFrame(`using ${keyPath}\n`)]);
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example', keyPath }],
            transport,
            requestPermission: allowAll(),
        });
        const output = await registration?.execute({ host: 'prod', command: 'whoami' }, toolContext());
        expect(output?.output).not.toContain(keyPath);
    });

    it('registers through a ToolRegistry when hosts are configured', async () => {
        const workspaceRoot = await makeWorkspace();
        const registry = new ToolRegistry();
        const advertisement = await registerSshTool(registry, {
            workspaceRoot,
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example' }],
            transport: mockTransport([singleFrame('ok\n')]).transport,
            requestPermission: allowAll(),
        });
        expect(advertisement?.name).toBe('ssh');
        expect(advertisement?.capabilityClasses).toContain('network');
        expect(advertisement?.capabilityClasses).toContain('bash.run');
    });

    it('has the expected registration shape (capability classes include network)', async () => {
        const registration = createSshToolRegistration({
            workspaceRoot: await makeWorkspace(),
            workspaceTrust: 'trusted',
            hosts: [{ name: 'prod', host: 'prod.example' }],
            transport: mockTransport([]).transport,
            requestPermission: allowAll(),
        });
        expect(registration?.name).toBe('ssh');
        expect(registration?.capabilityClasses).toEqual(['bash.run', 'network']);
        expect(registration?.inputSchema).toBeDefined();
        expect(registration?.outputSchema).toBeDefined();
        expect(typeof registration?.execute).toBe('function');
    });
});
