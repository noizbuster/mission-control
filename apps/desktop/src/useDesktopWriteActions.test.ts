// allow: SIZE_OK -- HEAD 189 -> current 253 pure LOC; write-action suite covers gates resume interrupt and effect resolve
import type { ModelProviderSelection, ProviderCredentialSummary } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type {
    DesktopAgentClient,
    DesktopApprovalDecisionInput,
    DesktopApprovalEffectRecord,
    DesktopApprovalEffectResolutionInput,
    DesktopApprovalEffectResolutionReceipt,
    DesktopCommandReceipt,
    DesktopPromptCommandInput,
    DesktopRunCommandInput,
    DesktopSessionLog,
    DesktopSessionSnapshot,
    DesktopSessionSummary,
    SaveDesktopProviderCredentialInput,
} from './lib/agent-client.js';
import {
    type DesktopWriteActionsInput,
    resolveDesktopApprovalEffect,
    runDesktopPromptCommand,
    runDesktopSessionCommand,
} from './useDesktopWriteActions.js';

describe('Desktop write actions', () => {
    it('blocks unsupported provider write attempts before client command invocation', async () => {
        const fixture = writeActionFixture({
            providerRunGate: {
                canStart: false,
                message: 'run disabled: unsupported',
            },
        });

        for (const kind of ['submit', 'queue', 'steer'] as const) {
            await runDesktopPromptCommand(
                fixture.input,
                kind,
                'change the workspace',
                fixture.recordActionMessage,
                fixture.recordPromptValue,
            );
        }

        expect(fixture.actionMessages).toEqual([
            'run disabled: unsupported',
            'run disabled: unsupported',
            'run disabled: unsupported',
        ]);
        expect(fixture.promptValues).toEqual([]);
        expect(fixture.clientCalls).toEqual([]);
    });

    it('keeps resume available when the current provider control is disabled', async () => {
        const fixture = writeActionFixture({
            providerRunGate: {
                canStart: false,
                message: 'run disabled: model discovery only',
            },
        });

        await runDesktopSessionCommand(fixture.input, 'resume', fixture.recordActionMessage);

        expect(fixture.clientCalls).toEqual(['resumeRun', 'listSessions', 'readSessionEvents', 'readSessionSnapshot']);
        expect(fixture.actionMessages).toEqual(['completed: 1 events']);
    });

    it('keeps interrupt available when provider execution is disabled', async () => {
        const fixture = writeActionFixture({
            providerRunGate: {
                canStart: false,
                message: 'run disabled: model discovery only',
            },
        });

        await runDesktopSessionCommand(fixture.input, 'interrupt', fixture.recordActionMessage);

        expect(fixture.clientCalls).toEqual([
            'interruptRun',
            'listSessions',
            'readSessionEvents',
            'readSessionSnapshot',
        ]);
        expect(fixture.actionMessages).toEqual(['interrupted: 1 events']);
    });

    it('records an unknown effect outcome without deciding approval and refreshes the session', async () => {
        // Given: an operator must settle an uncertain effect after recovery.
        const fixture = writeActionFixture({
            providerRunGate: {
                canStart: false,
                message: 'run disabled: model discovery only',
            },
        });

        // When: the operator marks the effect failed.
        const effect = await resolveDesktopApprovalEffect(
            fixture.input,
            { approvalId: 'approval_effect', outcome: 'failed' },
            fixture.recordActionMessage,
        );

        // Then: only the non-executing resolution seam runs before the projection refresh.
        expect(effect).toMatchObject({ state: 'unknown', outcome: 'failed' });
        expect(fixture.clientCalls).toEqual([
            'resolveApprovalEffect',
            'listSessions',
            'readSessionEvents',
            'readSessionSnapshot',
        ]);
        expect(fixture.actionMessages).toEqual(['effect marked failed']);
    });
});

type WriteActionFixtureInput = Pick<DesktopWriteActionsInput, 'providerRunGate'>;

type WriteActionFixture = {
    readonly input: DesktopWriteActionsInput;
    readonly actionMessages: string[];
    readonly promptValues: string[];
    readonly clientCalls: string[];
    readonly recordActionMessage: (message: string) => void;
    readonly recordPromptValue: (prompt: string) => void;
};

function writeActionFixture({ providerRunGate }: WriteActionFixtureInput): WriteActionFixture {
    const actionMessages: string[] = [];
    const promptValues: string[] = [];
    const clientCalls: string[] = [];
    const input: DesktopWriteActionsInput = {
        client: spyClient(clientCalls),
        sessionId: 'session_blocked',
        modelProviderSelection: modelProviderSelection(),
        providerRunGate,
        setSessionId: () => {},
        setSessionSummaries: () => {},
        setSessionLog: () => {},
        setSourceState: () => {},
        setSourceMessage: () => {},
    };
    return {
        input,
        actionMessages,
        promptValues,
        clientCalls,
        recordActionMessage: (message) => {
            actionMessages.push(message);
        },
        recordPromptValue: (prompt) => {
            promptValues.push(prompt);
        },
    };
}

function spyClient(calls: string[]): DesktopAgentClient {
    return {
        async listSessions(): Promise<readonly DesktopSessionSummary[]> {
            calls.push('listSessions');
            return [];
        },
        async readSessionEvents(sessionId: string): Promise<DesktopSessionLog> {
            calls.push('readSessionEvents');
            return sessionLog(sessionId);
        },
        async readSessionSnapshot(sessionId: string): Promise<DesktopSessionSnapshot> {
            calls.push('readSessionSnapshot');
            return {
                sessionId,
                state: 'missing',
                eventCount: 0,
                graphIds: [],
                diagnostics: [],
            };
        },
        async submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            calls.push('submitPrompt');
            return receipt(input.sessionId, 'completed');
        },
        async queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            calls.push('queueFollowUp');
            return receipt(input.sessionId, 'queued');
        },
        async steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            calls.push('steerRun');
            return receipt(input.sessionId, 'completed');
        },
        async interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            calls.push('interruptRun');
            return receipt(input.sessionId, 'interrupted');
        },
        async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            calls.push('resumeRun');
            return receipt(input.sessionId, 'completed');
        },
        async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
            calls.push('decideApproval');
            return receipt(input.sessionId, 'completed');
        },
        async getApprovalEffect(): Promise<DesktopApprovalEffectRecord | undefined> {
            calls.push('getApprovalEffect');
            return undefined;
        },
        async resolveApprovalEffect(
            input: DesktopApprovalEffectResolutionInput,
        ): Promise<DesktopApprovalEffectResolutionReceipt> {
            calls.push('resolveApprovalEffect');
            return {
                sessionId: input.sessionId,
                status: 'resolved',
                effect: unknownEffectRecord(input.sessionId, input.approvalId, input.outcome),
            };
        },
        async listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]> {
            calls.push('listProviderCredentials');
            return [];
        },
        async saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary> {
            calls.push('saveProviderCredential');
            return {
                providerID: input.providerID,
                authenticated: true,
                credentialType: 'apiKey',
                maskedCredential: 'mc_...test',
            };
        },
    };
}

function modelProviderSelection(): ModelProviderSelection {
    return {
        providerID: 'cloudflare-ai-gateway',
        modelID: 'cloudflare-model',
    };
}

function receipt(sessionId: string, status: DesktopCommandReceipt['status']): DesktopCommandReceipt {
    return {
        sessionId,
        status,
        eventsWritten: 1,
    };
}

function sessionLog(sessionId: string): DesktopSessionLog {
    return {
        sessionId,
        state: 'missing',
        contents: '',
        envelopes: [],
        diagnostics: [],
    };
}

function unknownEffectRecord(
    sessionId: string,
    approvalId: string,
    outcome: 'completed' | 'failed',
): DesktopApprovalEffectRecord {
    return {
        state: 'unknown',
        requestedAt: '2026-07-15T03:00:00.000Z',
        executionToken: 'execution_token',
        leaseExpiresAt: '2026-07-15T03:01:00.000Z',
        executingAt: '2026-07-15T03:00:01.000Z',
        unknownAt: '2026-07-15T03:02:00.000Z',
        outcome,
        resolvedAt: '2026-07-15T03:03:00.000Z',
        effect: {
            sessionId,
            approvalId,
            runId: 'run_effect',
            toolCallId: 'call_effect',
            toolName: 'command.run',
            argumentsJson: '{"command":"node"}',
            workspaceRoot: '/workspace',
        },
    };
}
