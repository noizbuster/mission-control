import {
    InProcessLspClient,
    type LspClient,
    type LspDiagnostic,
    type LspServerManagerDeps,
    type SdkModelResolver,
} from '@mission-control/core';
import type {
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ToolCall,
} from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveApprovalBroker } from './interactive-approval-broker.js';
import {
    createInteractiveToolRegistry,
    type InteractiveToolOptions,
    preflightInteractiveToolCall,
} from './interactive-coding-tools.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('interactive coding tools preflight', () => {
    it('rejects ambiguous file.edit selectors before approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.edit', 'edit_ambiguous', {
                path: 'notes.txt',
                oldText: 'before',
                newText: 'after',
                occurrence: 1,
                replaceAll: false,
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
                setApprovalLevel: () => undefined,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toContain('Edit preview for file.edit');
        expect(output.getOutput()).toContain('"replaceAll":false');
        expect(output.getOutput()).not.toContain('--- a/notes.txt');
    });

    it('rejects no-op file.edit before approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.edit', 'edit_noop', {
                path: 'notes.txt',
                oldText: 'same',
                newText: 'same',
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
                setApprovalLevel: () => undefined,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toContain('Edit preview for file.edit');
    });

    it('rejects binary file.write before preview approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.write', 'write_binary', {
                path: 'notes.bin',
                content: '\u0000\u0001binary',
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
                setApprovalLevel: () => undefined,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toBe('');
    });
});

describe('interactive coding tool registry surface', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises glob, todowrite, webfetch, and task in the built registry', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-registry-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();

        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, throwingResolver),
            fakeBroker(),
        );

        const advertised = registry.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).toContain('glob');
        expect(advertised).toContain('todowrite');
        expect(advertised).toContain('webfetch');
        expect(advertised).toContain('task');
        expect(advertised).toContain('skill');
        expect(advertised).not.toContain('lsp');
        expect(advertised.some((name) => name.startsWith('mcp__'))).toBe(false);
        const webfetchAd = registry.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'webfetch');
        expect(webfetchAd?.guideline).toBeDefined();
        const taskAd = registry.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'task');
        expect(taskAd?.guideline).toBeDefined();
        expect(taskAd?.capabilityClasses).toContain('subagent');
    });

    it('omits the task tool when resolveSdkModel is not provided', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-no-task-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();

        const registry = await createInteractiveToolRegistry(toolOptions(output.output, workspaceRoot), fakeBroker());

        const advertised = registry.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('task');
        expect(advertised).toContain('webfetch');
    });

    it('does NOT advertise lsp by default (no LspClient injected)', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-no-lsp-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();

        const registry = await createInteractiveToolRegistry(toolOptions(output.output, workspaceRoot), fakeBroker());

        const advertised = registry.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('lsp');
    });

    it('advertises lsp with a guideline when a stub LspClient is injected', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-lsp-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();
        const stubClient = new InProcessLspClient({});

        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, undefined, stubClient),
            fakeBroker(),
        );

        const lspAd = registry.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'lsp');
        expect(lspAd).toBeDefined();
        expect(lspAd?.guideline).toBeDefined();
        expect(lspAd?.capabilityClasses).toContain('read');
    });

    it('runs lsp diagnostics end-to-end through the registry when a stub client is injected', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-lsp-invoke-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();
        const diagnostics: ReadonlyArray<{ uri: string; items: readonly LspDiagnostic[] }> = [
            {
                uri: 'file:///workspace/a.ts',
                items: [{ message: 'Type mismatch', severity: 'error', line: 3, character: 5, source: 'tsserver' }],
            },
        ];
        const stubClient = new InProcessLspClient({ diagnostics });

        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, undefined, stubClient),
            fakeBroker(),
        );

        const lspAd = registry.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'lsp');
        if (lspAd === undefined) {
            throw new Error('lsp tool was not advertised with a stub client');
        }
        const settlement = await registry.registry.invoke({
            toolCallId: 'lsp_call',
            toolName: 'lsp',
            advertisedVersion: lspAd.version,
            argumentsJson: JSON.stringify({ operation: 'diagnostics', uri: 'file:///workspace/a.ts' }),
        });
        expect(settlement.result.status).toBe('completed');
        expect(JSON.stringify(settlement.structuredOutput)).toContain('Type mismatch');
    });

    function fakeBroker(): InteractiveApprovalBroker {
        return {
            requestApproval: async (request) => ({
                requestId: request.id,
                status: 'deny',
                reason: 'test broker',
            }),
            requestPermission: async (request) => ({
                requestId: request.id,
                status: 'allow',
                reason: 'test broker',
            }),
            primeApproval: () => undefined,
            answer: () => false,
            cancel: () => undefined,
            hasPending: () => false,
            setApprovalLevel: () => undefined,
        };
    }
});

describe('non-interactive coding tool registry surface', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises glob, todowrite, webfetch, task, and skill through createNonInteractiveToolRegistry', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-registry-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            resolveSdkModel: throwingResolver,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            sessionId: 'session_noninteractive_tools',
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).toContain('glob');
        expect(advertised).toContain('todowrite');
        expect(advertised).toContain('webfetch');
        expect(advertised).toContain('task');
        expect(advertised).toContain('skill');
        const taskAd = result.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'task');
        expect(taskAd?.guideline).toBeDefined();
        expect(taskAd?.capabilityClasses).toContain('subagent');
    });

    it('does NOT advertise mcp__* or lsp by default (empty MCP config, no LspClient)', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-no-mcp-lsp-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            lspServerManagerDeps: noLspServers,
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('lsp');
        expect(advertised.some((name) => name.startsWith('mcp__'))).toBe(false);
    });

    it('omits the task tool when resolveSdkModel is not provided', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-no-task-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('task');
        expect(advertised).toContain('webfetch');
        expect(advertised).toContain('glob');
        expect(advertised).toContain('todowrite');
        expect(advertised).toContain('skill');
    });
});

describe('web_search tool wiring', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises web_search with network capability when EXA_API_KEY is configured (interactive)', async () => {
        vi.stubEnv('EXA_API_KEY', 'test-exa-key');
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-websearch-interactive-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();

        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot),
            webSearchBroker(),
        );

        const ad = registry.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'web_search');
        expect(ad).toBeDefined();
        expect(ad?.capabilityClasses).toContain('network');
        expect(ad?.guideline).toBeDefined();
    });

    it('omits web_search when no search provider env var is configured (interactive)', async () => {
        const savedExa = process.env['EXA_API_KEY'];
        const savedParallel = process.env['PARALLEL_API_KEY'];
        delete process.env['EXA_API_KEY'];
        delete process.env['PARALLEL_API_KEY'];
        try {
            const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-websearch-omitted-'));
            tempRoots.push(workspaceRoot);
            const output = createBufferedChatOutput();

            const registry = await createInteractiveToolRegistry(
                toolOptions(output.output, workspaceRoot),
                webSearchBroker(),
            );

            const advertised = registry.registry
                .advertise()
                .map((advertisement: { name: string }) => advertisement.name);
            expect(advertised).not.toContain('web_search');
        } finally {
            if (savedExa !== undefined) process.env['EXA_API_KEY'] = savedExa;
            if (savedParallel !== undefined) process.env['PARALLEL_API_KEY'] = savedParallel;
        }
    });

    it('advertises web_search when PARALLEL_API_KEY is configured (non-interactive)', async () => {
        vi.stubEnv('PARALLEL_API_KEY', 'test-parallel-key');
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-websearch-noninteractive-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            sessionId: 'session_websearch_noninteractive',
        });

        const ad = result.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'web_search');
        expect(ad).toBeDefined();
        expect(ad?.capabilityClasses).toContain('network');
    });

    it('builds a network permission request for web_search during preflight', async () => {
        const output = createBufferedChatOutput();
        const captured: PermissionRequest[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('web_search', 'search_call', { query: 'latest rust async runtime' }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    captured.push(request);
                    return { requestId: request.id, status: 'deny', reason: 'test deny' };
                },
                primeApproval: () => undefined,
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
                setApprovalLevel: () => undefined,
            },
        );

        expect(captured).toHaveLength(1);
        const request = captured[0];
        if (request === undefined) throw new Error('permission request not captured');
        if (request.permission === undefined) throw new Error('permission scope not set on web_search request');
        expect(request.action).toBe('web_search');
        expect(request.permission.kind).toBe('network');
        expect(request.permission.patterns).toContain('latest rust async runtime');
        expect(settlement?.result.status).toBe('failed');
    });

    function webSearchBroker(): InteractiveApprovalBroker {
        return {
            requestApproval: async (request) => ({
                requestId: request.id,
                status: 'deny',
                reason: 'test broker',
            }),
            requestPermission: async (request) => ({
                requestId: request.id,
                status: 'allow',
                reason: 'test broker',
            }),
            primeApproval: () => undefined,
            answer: () => false,
            cancel: () => undefined,
            hasPending: () => false,
            setApprovalLevel: () => undefined,
        };
    }
});

function toolOptions(
    output: InteractiveToolOptions['output'],
    workspaceRoot = '/workspace',
    resolveSdkModel?: SdkModelResolver,
    lspClient?: LspClient,
): InteractiveToolOptions {
    const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
    return {
        workspaceRoot,
        sessionId: 'session_interactive_tools',
        modelProviderSelection,
        output,
        emitEvent: () => undefined,
        ...(resolveSdkModel !== undefined ? { resolveSdkModel } : {}),
        ...(lspClient !== undefined ? { lspClient } : {}),
        lspServerManagerDeps: noLspServers,
    };
}

const noLspServers: LspServerManagerDeps = { commandExists: async () => false };

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}

const throwingResolver: SdkModelResolver = () => {
    throw new Error('resolveSdkModel should not be invoked during registry construction');
};

const allowAllPermission = async (request: PermissionRequest): Promise<PermissionDecision> => ({
    requestId: request.id,
    status: 'allow',
    reason: 'non-interactive test fake',
});
