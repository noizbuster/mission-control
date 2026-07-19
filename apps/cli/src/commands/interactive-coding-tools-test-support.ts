import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LspClient, LspServerManagerDeps, ProjectTrustReader, SdkModelResolver } from '@mission-control/core';
import type {
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ToolCall,
} from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
import type { InteractiveToolOptions } from './interactive-coding-tools';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';

export const noLspServers: LspServerManagerDeps = { commandExists: async () => false };

export const trustedProjectTrustStore: ProjectTrustReader = {
    getDecision: async (workspaceRoot) => ({
        decision: 'trusted',
        workspaceRoot,
        filePath: '/test/trust/projects.json',
        storeState: 'valid',
    }),
};

export function fakeBroker(): InteractiveApprovalBroker {
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
        primeApproval: (_request, _reason) => undefined,
        answer: () => false,
        cancel: () => undefined,
        hasPending: () => false,
        setApprovalLevel: () => undefined,
    };
}

export function toolOptions(
    output: InteractiveToolOptions['output'],
    workspaceRoot = '/workspace',
    resolveSdkModel?: SdkModelResolver,
    lspClient?: LspClient,
): InteractiveToolOptions & { readonly executionTurnId: string; readonly renderState: ProviderRenderState } {
    const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
    return {
        executionTurnId: 'test-interactive-tools-turn',
        renderState: createProviderRenderState('test-interactive-tools-turn'),
        workspaceRoot,
        sessionId: 'session_interactive_tools',
        modelProviderSelection,
        output,
        emitEvent: () => undefined,
        projectTrustStore: trustedProjectTrustStore,
        ...(resolveSdkModel !== undefined ? { resolveSdkModel } : {}),
        ...(lspClient !== undefined ? { lspClient } : {}),
        lspServerManagerDeps: noLspServers,
    };
}

export function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}

export const throwingResolver: SdkModelResolver = () => {
    throw new Error('resolveSdkModel should not be invoked during registry construction');
};

export function capturingYieldResolver(capturedToolNames: string[][]): SdkModelResolver {
    const model = new MockLanguageModelV3({
        provider: 'test',
        modelId: 'capturing-yield',
        doStream: async (options) => {
            capturedToolNames.push((options.tools ?? []).map((tool) => tool.name));
            const input = JSON.stringify({ result: 'child completed' });
            const chunks: LanguageModelV3StreamPart[] = [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-input-start', id: 'yield-call', toolName: 'yield' },
                { type: 'tool-input-delta', id: 'yield-call', delta: input },
                { type: 'tool-input-end', id: 'yield-call' },
                { type: 'tool-call', toolCallId: 'yield-call', toolName: 'yield', input },
                {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                },
            ];
            return { stream: convertArrayToReadableStream(chunks) };
        },
    });
    return () => model;
}

export const allowAllPermission = async (request: PermissionRequest): Promise<PermissionDecision> => ({
    requestId: request.id,
    status: 'allow',
    reason: 'non-interactive test fake',
});
