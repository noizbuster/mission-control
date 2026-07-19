import {
    createSqlTaskRuntimeServices,
    InProcessLspClient,
    type LspDiagnostic,
    openSqliteSessionProjectionStore,
} from '@mission-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createInteractiveToolRegistry, preflightInteractiveToolCall } from './interactive-coding-tools';
import {
    capturingYieldResolver,
    fakeBroker,
    throwingResolver,
    toolCall,
    toolOptions,
} from './interactive-coding-tools-test-support';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
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
                primeApproval: (request) => {
                    primedRequests.push(request.id);
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
                primeApproval: (request) => {
                    primedRequests.push(request.id);
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
                primeApproval: (request) => {
                    primedRequests.push(request.id);
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

    it('advertises staged preview, glob, todowrite, webfetch, and task tools in the built registry', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-registry-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();

        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, throwingResolver),
            fakeBroker(),
        );

        const advertised = registry.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).toContain('glob');
        expect(advertised).toContain('ast_grep');
        expect(advertised).toContain('ast_edit');
        expect(advertised).toContain('resolve');
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

    it('keeps the interactive root honest: explore category denies remove child mutation tools', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-child-policy-'));
        tempRoots.push(workspaceRoot);
        const output = createBufferedChatOutput();
        const capturedToolNames: string[][] = [];
        const result = await createInteractiveToolRegistry(
            {
                ...toolOptions(output.output, workspaceRoot, capturingYieldResolver(capturedToolNames)),
                enableTrustedBash: true,
            },
            fakeBroker(),
        );
        const task = result.registry.advertise().find((advertisement) => advertisement.name === 'task');
        if (task === undefined) throw new Error('task tool was not registered');

        const settlement = await result.registry.invoke({
            toolCallId: 'interactive-explore-task',
            toolName: 'task',
            advertisedVersion: task.version,
            argumentsJson: JSON.stringify({ category: 'explore', prompt: 'inspect without mutations' }),
        });

        expect(settlement.result.status).toBe('completed');
        expect(capturedToolNames[0]).not.toContain('file.write');
        expect(capturedToolNames[0]).not.toContain('bash.run');
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

    it('marks the parent session awaiting/user_input while interactive ask_user is pending', async () => {
        // Given
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-interactive-ask-user-await-'));
        tempRoots.push(workspaceRoot);
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-interactive-ask-user-data-'));
        tempRoots.push(dataDir);
        const services = await createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false });
        const publicStore = await openSqliteSessionProjectionStore({ dataDir });
        const output = createBufferedChatOutput();
        let releaseAnswer: ((value: string) => void) | undefined;
        const pendingAnswer = new Promise<string>((resolve) => {
            releaseAnswer = resolve;
        });
        let markHostEntered: () => void = () => undefined;
        const hostEntered = new Promise<void>((resolve) => {
            markHostEntered = resolve;
        });
        const registry = await createInteractiveToolRegistry(
            {
                ...toolOptions(output.output, workspaceRoot),
                requestUserQuestion: async () => {
                    markHostEntered();
                    return pendingAnswer;
                },
                services,
            },
            fakeBroker(),
        );
        const askUser = registry.registry.advertise().find((advertisement) => advertisement.name === 'ask_user');
        if (askUser === undefined) throw new Error('ask_user was not registered');

        // When: invoke ask_user and leave the host callback pending
        const invokePromise = registry.registry.invoke({
            toolCallId: 'ask_user_pending',
            toolName: 'ask_user',
            advertisedVersion: askUser.version,
            argumentsJson: JSON.stringify({ question: 'Ship it?', options: ['yes', 'no'] }),
        });
        await hostEntered;
        await services.flush();
        const whilePending = await publicStore.getSession('session_interactive_tools');

        // Then
        expect(whilePending).toMatchObject({
            sessionId: 'session_interactive_tools',
            status: 'awaiting',
            awaiting: {
                reason: 'user_input',
                source: { toolCallId: 'ask_user_pending' },
            },
        });

        // When: host answers
        releaseAnswer?.('yes');
        const settlement = await invokePromise;
        await services.flush();
        const afterAnswer = await publicStore.getSession('session_interactive_tools');
        publicStore.close();
        await services.close();

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(afterAnswer?.status).not.toBe('awaiting');
        expect(afterAnswer?.awaiting).toBeUndefined();
    });
});
