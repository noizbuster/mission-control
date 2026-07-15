import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
import { createInteractiveToolRegistry, preflightInteractiveToolCall } from './interactive-coding-tools';
import { allowAllPermission, toolCall, toolOptions } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('web_search tool wiring', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises web_search with network capability when EXA_API_KEY is configured in interactive mode', async () => {
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

    it('omits web_search when no search provider env var is configured in interactive mode', async () => {
        const savedExa = readSearchProviderEnv('EXA_API_KEY');
        const savedParallel = readSearchProviderEnv('PARALLEL_API_KEY');
        deleteSearchProviderEnv('EXA_API_KEY');
        deleteSearchProviderEnv('PARALLEL_API_KEY');
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
            restoreSearchProviderEnv('EXA_API_KEY', savedExa);
            restoreSearchProviderEnv('PARALLEL_API_KEY', savedParallel);
        }
    });

    it('advertises web_search when PARALLEL_API_KEY is configured in noninteractive mode', async () => {
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

type SearchProviderEnvKey = 'EXA_API_KEY' | 'PARALLEL_API_KEY';

function readSearchProviderEnv(key: SearchProviderEnvKey): string | undefined {
    return process.env[key];
}

function deleteSearchProviderEnv(key: SearchProviderEnvKey): void {
    Reflect.deleteProperty(process.env, key);
}

function restoreSearchProviderEnv(key: SearchProviderEnvKey, value: string | undefined): void {
    if (value !== undefined) {
        process.env[key] = value;
    }
}
