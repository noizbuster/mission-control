import type { ModelProviderSelection, ProviderCredentialSummary } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type {
    DesktopAgentClient,
    DesktopApprovalDecisionInput,
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
