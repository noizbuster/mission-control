import { AgentRuntime, ProjectTrustStore, type ProviderAdapter, type ProviderTurnRequest } from '@mission-control/core';
import type { ModelProviderSelection, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { createInteractiveToolRegistry } from './interactive-coding-tools.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('coding-agent bash advertisement', () => {
    const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('does not advertise bash.run when the registry policy disables trusted bash', async () => {
        const workspaceRoot = await tempRoot('mctrl-policy-disabled-workspace-');
        const output = createBufferedChatOutput();
        const registry = await createInteractiveToolRegistry(
            {
                workspaceRoot,
                sessionId: 'session_policy_disabled',
                modelProviderSelection,
                output: output.output,
                emitEvent: () => undefined,
                enableTrustedBash: false,
            },
            allowAllApprovals(),
        );

        expect(registry.advertise().map((tool) => tool.name)).not.toContain('bash.run');
    });

    it('advertises bash.run for interactive coding only after the workspace is trusted', async () => {
        const dataDir = await tempRoot('mctrl-interactive-bash-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-bash-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const trustedStore = new ProjectTrustStore({ dataDir });
        const output = createBufferedChatOutput();

        const untrusted = await createInteractiveToolRegistry(
            {
                workspaceRoot,
                sessionId: 'session_untrusted',
                modelProviderSelection,
                output: output.output,
                emitEvent: () => undefined,
                enableTrustedBash: false,
            },
            allowAllApprovals(),
        );
        expect(untrusted.advertise().map((tool) => tool.name)).not.toContain('bash.run');

        await trustedStore.setDecision(workspaceRoot, 'trusted');
        const trusted = await createInteractiveToolRegistry(
            {
                workspaceRoot,
                sessionId: 'session_trusted',
                modelProviderSelection,
                output: output.output,
                emitEvent: () => undefined,
                enableTrustedBash: true,
            },
            allowAllApprovals(),
        );
        expect(trusted.advertise().map((tool) => tool.name)).toContain('bash.run');
    });

    it('omits bash.run from non-interactive model advertisement until the workspace is trusted', async () => {
        const dataDir = await tempRoot('mctrl-headless-bash-data-');
        const workspaceRoot = await tempRoot('mctrl-headless-bash-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const unknownRequests: ProviderTurnRequest[] = [];
        const unknownRuntime = new AgentRuntime(
            createCliRuntimeOptions({
                provider: captureProvider(unknownRequests),
                workspaceRoot,
            }),
        );
        await unknownRuntime.start();
        await unknownRuntime.runPromptTask('before trust');
        expect(unknownRequests[0]?.tools?.map((tool) => tool.name)).not.toContain('bash.run');

        const trustStore = new ProjectTrustStore({ dataDir });
        await trustStore.setDecision(workspaceRoot, 'trusted');

        const trustedRequests: ProviderTurnRequest[] = [];
        const trustedRuntime = new AgentRuntime(
            createCliRuntimeOptions({
                provider: captureProvider(trustedRequests),
                workspaceRoot,
            }),
        );
        await trustedRuntime.start();
        await trustedRuntime.runPromptTask('after trust');
        expect(trustedRequests[0]?.tools?.map((tool) => tool.name)).toContain('bash.run');
    });
});

function allowAllApprovals() {
    return {
        requestApproval: async (request: PermissionRequest): Promise<PermissionDecision> => allowPermission(request),
        requestPermission: async (request: PermissionRequest): Promise<PermissionDecision> => allowPermission(request),
        primeApproval: () => undefined,
        answer: () => false,
        cancel: () => undefined,
        hasPending: () => false,
    };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function captureProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: 'ok',
                },
                finishReason: 'stop',
            };
        },
    };
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
