import {
    type ObservabilityRedactor,
    redactAgentEventForObservability,
    type SessionRunOwner,
    type SessionRunOwnerReceipt,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { ActiveCodingAgentTurnOutcome, CodingAgentTurnOptions } from './interactive-coding-agent-types';
import type { ProviderRenderState } from './interactive-coding-graph-rendering';

type OwnedTurnOptions = Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string };

type OwnedTurnAction = {
    readonly taskStartedMessage: string;
    readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
};

export async function runOwnedCodingAgentTurn(
    options: OwnedTurnOptions,
    owner: SessionRunOwner,
    renderState: ProviderRenderState,
    action: OwnedTurnAction,
    observabilityRedactor: ObservabilityRedactor,
): Promise<ActiveCodingAgentTurnOutcome> {
    const turnStartedAt = Date.now();
    emitInteractiveTaskEvent(
        options,
        { type: 'task.started', message: action.taskStartedMessage },
        observabilityRedactor,
    );
    const receipt = await action.execute(owner);
    settleReceipt(options, receipt, renderState, observabilityRedactor, turnStartedAt);
    return receipt.status;
}

export function emitInteractiveTaskEvent(
    options: OwnedTurnOptions,
    event: {
        readonly type: 'task.started' | 'task.completed' | 'task.failed';
        readonly message: string;
        readonly run?: NonNullable<AgentEvent['run']>;
    },
    observabilityRedactor: ObservabilityRedactor,
): void {
    options.emitEvent(
        redactAgentEventForObservability(
            {
                type: event.type,
                timestamp: new Date().toISOString(),
                sessionId: options.sessionId,
                taskId: options.turnId,
                message: event.message,
                nativeSidecarStatus: 'mock',
                modelProviderSelection: options.modelProviderSelection,
                ...(event.run !== undefined ? { run: event.run } : {}),
            },
            observabilityRedactor,
        ),
    );
}

function settleReceipt(
    options: OwnedTurnOptions,
    receipt: SessionRunOwnerReceipt,
    renderState: ProviderRenderState,
    observabilityRedactor: ObservabilityRedactor,
    turnStartedAt: number,
): void {
    switch (receipt.status) {
        case 'completed':
            emitInteractiveTaskEvent(
                options,
                {
                    type: 'task.completed',
                    message: renderState.finalMessage ?? 'run completed',
                    run: { runId: receipt.runId, state: 'completed' },
                },
                observabilityRedactor,
            );
            options.output.write(
                formatCodingTurnFooter(turnStartedAt, 'completed', renderState.finalMessage ?? 'run completed'),
            );
            return;
        case 'interrupted':
            options.output.write('Interrupted active run\n');
            emitInteractiveTaskEvent(
                options,
                {
                    type: 'task.failed',
                    message: 'provider turn interrupted',
                    run: { runId: receipt.runId, state: 'interrupted' },
                },
                observabilityRedactor,
            );
            options.output.write(formatCodingTurnFooter(turnStartedAt, 'interrupted', 'interrupted by user'));
            return;
        case 'blocked_on_approval': {
            const reason = receipt.reason ?? 'approval required';
            options.output.write(formatBlockedRunMessage(reason, receipt.toolCallId));
            options.output.write(formatCodingTurnFooter(turnStartedAt, 'blocked', reason));
            return;
        }
        case 'failed': {
            const reason = observabilityRedactor.redactText(receipt.reason ?? 'run failed');
            options.output.write(`Error: ${reason}\n`);
            emitInteractiveTaskEvent(
                options,
                {
                    type: 'task.failed',
                    message: reason,
                    run: {
                        runId: receipt.runId,
                        state: 'failed',
                        ...(receipt.reason !== undefined
                            ? { reason: observabilityRedactor.redactText(receipt.reason) }
                            : {}),
                        ...(receipt.errorCode !== undefined ? { errorCode: receipt.errorCode } : {}),
                    },
                },
                observabilityRedactor,
            );
            options.output.write(formatCodingTurnFooter(turnStartedAt, 'failed', reason));
            return;
        }
        case 'idle':
        case 'running':
        case 'queued':
            return;
        default:
            assertNeverReceipt(receipt.status);
    }
}

function formatBlockedRunMessage(reason: string, toolCallId?: string): string {
    const details = toolCallId === undefined ? '' : ` Pending tool call: ${toolCallId}.`;
    return `Run blocked (resumable): ${reason}. Resume with /continue.${details}\n`;
}

function formatCodingTurnFooter(turnStartedAt: number, status: string, reason: string): string {
    const elapsedMs = Math.max(0, Date.now() - turnStartedAt);
    const seconds = elapsedMs / 1000;
    const elapsedLabel = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    const detail = reason.trim().length === 0 ? status : `${status} (${reason})`;
    return `\n---\nTurn elapsed: ${elapsedLabel}s · Stop reason: ${detail}\n`;
}

function assertNeverReceipt(value: never): never {
    throw new Error(`Unexpected run owner receipt status: ${String(value)}`);
}
