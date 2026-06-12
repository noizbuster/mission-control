import type { ModelProviderSelection } from '@mission-control/protocol';
import { useState } from 'react';
import type {
    DesktopAgentClient,
    DesktopApprovalDecisionState,
    DesktopCommandReceipt,
    DesktopSessionLog,
    DesktopSessionSummary,
} from './lib/agent-client.js';

type SessionSourceState = 'loading' | 'ready' | 'error';
type PromptCommandKind = 'submit' | 'queue' | 'steer';
type SessionCommandKind = 'interrupt' | 'resume';

export type ProviderRunGate = {
    readonly canStart: boolean;
    readonly message: string;
};

export type DesktopWriteActionsInput = {
    readonly client: DesktopAgentClient;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly providerRunGate: ProviderRunGate;
    readonly setSessionId: (sessionId: string) => void;
    readonly setSessionSummaries: (sessions: readonly DesktopSessionSummary[]) => void;
    readonly setSessionLog: (log: DesktopSessionLog) => void;
    readonly setSourceState: (state: SessionSourceState) => void;
    readonly setSourceMessage: (message: string) => void;
};

export function useDesktopWriteActions(input: DesktopWriteActionsInput) {
    const [promptValue, setPromptValue] = useState<string>('');
    const [actionMessage, setActionMessage] = useState<string>('ready');

    async function decideApproval(approvalId: string, state: DesktopApprovalDecisionState): Promise<void> {
        if (input.sessionId.length === 0) {
            setActionMessage('session required');
            return;
        }
        const receipt = await input.client.decideApproval({
            sessionId: input.sessionId,
            approvalId,
            state,
            reason: 'desktop approval decision',
        });
        await reloadAfterWrite(input, receipt, setActionMessage);
    }

    return {
        promptValue,
        actionMessage,
        setPromptValue,
        submitPrompt: () => runDesktopPromptCommand(input, 'submit', promptValue, setActionMessage, setPromptValue),
        queueFollowUp: () => runDesktopPromptCommand(input, 'queue', promptValue, setActionMessage, setPromptValue),
        steerRun: () => runDesktopPromptCommand(input, 'steer', promptValue, setActionMessage, setPromptValue),
        interruptRun: () => runDesktopSessionCommand(input, 'interrupt', setActionMessage),
        resumeRun: () => runDesktopSessionCommand(input, 'resume', setActionMessage),
        decideApproval,
    };
}

export async function runDesktopPromptCommand(
    input: DesktopWriteActionsInput,
    kind: PromptCommandKind,
    promptValue: string,
    setActionMessage: (message: string) => void,
    setPromptValue: (prompt: string) => void,
): Promise<void> {
    const blockedMessage = providerRunBlockMessage(input.providerRunGate);
    if (blockedMessage !== undefined) {
        setActionMessage(blockedMessage);
        return;
    }
    const prompt = promptValue.trim();
    if (prompt.length === 0) {
        setActionMessage('prompt required');
        return;
    }
    if (input.sessionId.length === 0) {
        setActionMessage('session required');
        return;
    }
    const commandInput = {
        sessionId: input.sessionId,
        prompt,
        modelProviderSelection: input.modelProviderSelection,
    };
    const receipt =
        kind === 'submit'
            ? await input.client.submitPrompt(commandInput)
            : kind === 'queue'
              ? await input.client.queueFollowUp(commandInput)
              : await input.client.steerRun(commandInput);
    await reloadAfterWrite(input, receipt, setActionMessage);
    if (kind !== 'queue') {
        setPromptValue('');
    }
}

export async function runDesktopSessionCommand(
    input: DesktopWriteActionsInput,
    kind: SessionCommandKind,
    setActionMessage: (message: string) => void,
): Promise<void> {
    if (input.sessionId.length === 0) {
        setActionMessage('session required');
        return;
    }
    const receipt =
        kind === 'interrupt'
            ? await input.client.interruptRun({ sessionId: input.sessionId, reason: 'desktop interrupt' })
            : await input.client.resumeRun({ sessionId: input.sessionId });
    await reloadAfterWrite(input, receipt, setActionMessage);
}

export function providerRunBlockMessage(gate: ProviderRunGate): string | undefined {
    return gate.canStart ? undefined : gate.message;
}

async function reloadAfterWrite(
    input: DesktopWriteActionsInput,
    receipt: DesktopCommandReceipt,
    setActionMessage: (message: string) => void,
): Promise<void> {
    setActionMessage(`${receipt.status}: ${receipt.eventsWritten} events`);
    const [sessions, log, snapshot] = await Promise.all([
        input.client.listSessions(),
        input.client.readSessionEvents(receipt.sessionId),
        input.client.readSessionSnapshot(receipt.sessionId),
    ]);
    input.setSessionSummaries(sessions);
    input.setSessionLog(log);
    input.setSessionId(receipt.sessionId);
    input.setSourceState(log.state === 'corrupt' ? 'error' : 'ready');
    input.setSourceMessage(`${snapshot.eventCount} events, ${snapshot.graphIds.length} graphs`);
}
