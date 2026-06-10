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

export type DesktopWriteActionsInput = {
    readonly client: DesktopAgentClient;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly setSessionId: (sessionId: string) => void;
    readonly setSessionSummaries: (sessions: readonly DesktopSessionSummary[]) => void;
    readonly setSessionLog: (log: DesktopSessionLog) => void;
    readonly setSourceState: (state: SessionSourceState) => void;
    readonly setSourceMessage: (message: string) => void;
};

export function useDesktopWriteActions(input: DesktopWriteActionsInput) {
    const [promptValue, setPromptValue] = useState<string>('');
    const [actionMessage, setActionMessage] = useState<string>('ready');

    async function runPromptCommand(kind: 'submit' | 'queue' | 'steer'): Promise<void> {
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

    async function runSessionCommand(kind: 'interrupt' | 'resume'): Promise<void> {
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
        submitPrompt: () => runPromptCommand('submit'),
        queueFollowUp: () => runPromptCommand('queue'),
        steerRun: () => runPromptCommand('steer'),
        interruptRun: () => runSessionCommand('interrupt'),
        resumeRun: () => runSessionCommand('resume'),
        decideApproval,
    };
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
