import {
    type ObservabilityRedactor,
    redactAgentEventForObservability,
    type SessionRunOwner,
    type SessionRunOwnerReceipt,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { ActiveCodingAgentTurnOutcome, CodingAgentTurnOptions } from './interactive-coding-agent-types';
import {
    type ProviderRenderState,
    settleInterruptedToolTranscriptParts,
    settleTerminalToolTranscriptParts,
    stampToolPartAttribution,
} from './interactive-coding-transcript-render-state';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';

type OwnedTurnOptions = Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string };

type InteractiveTaskEventOptions = Pick<
    OwnedTurnOptions,
    'sessionId' | 'turnId' | 'modelProviderSelection' | 'emitEvent'
>;

type ReceiptSettlementOptions = InteractiveTaskEventOptions & Pick<OwnedTurnOptions, 'output'>;

type OwnedTurnAction = {
    readonly taskStartedMessage: string;
    readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
};

export type ReceiptSettlementInput = {
    readonly options: ReceiptSettlementOptions;
    readonly receipt: SessionRunOwnerReceipt;
    readonly renderState: ProviderRenderState;
    readonly observabilityRedactor: ObservabilityRedactor;
    readonly turnStartedAt: number;
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
    settleReceipt({ options, receipt, renderState, observabilityRedactor, turnStartedAt });
    return receipt.status;
}

export function emitInteractiveTaskEvent(
    options: InteractiveTaskEventOptions,
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

export function settleReceipt(input: ReceiptSettlementInput): void {
    const { options, receipt, renderState, observabilityRedactor, turnStartedAt } = input;
    switch (receipt.status) {
        case 'completed': {
            const completedParts = settleTerminalToolTranscriptParts(renderState, 'completed');
            if (options.output.writeTranscriptPart !== undefined) {
                for (const part of completedParts) {
                    emitTranscriptPart(
                        options.output,
                        stampToolPartAttribution(part, renderState.lastAssistantAttributionId),
                        '',
                    );
                }
            }
            emitInteractiveTaskEvent(
                options,
                {
                    type: 'task.completed',
                    message: renderState.finalMessage ?? 'run completed',
                    run: { runId: receipt.runId, state: 'completed' },
                },
                observabilityRedactor,
            );
            emitTranscriptFallback(
                options.output,
                formatCodingTurnFooter(turnStartedAt, 'completed', renderState.finalMessage ?? 'run completed'),
            );
            return;
        }
        case 'interrupted': {
            const interruptedParts = settleInterruptedToolTranscriptParts(renderState);
            if (interruptedParts === undefined) return;
            if (options.output.writeTranscriptPart !== undefined) {
                for (const part of interruptedParts) {
                    emitTranscriptPart(
                        options.output,
                        stampToolPartAttribution(part, renderState.lastAssistantAttributionId),
                        '',
                    );
                }
            }
            emitTranscriptFallback(options.output, 'Interrupted active run\n');
            emitInteractiveTaskEvent(
                options,
                {
                    type: 'task.failed',
                    message: 'provider turn interrupted',
                    run: { runId: receipt.runId, state: 'interrupted' },
                },
                observabilityRedactor,
            );
            emitTranscriptFallback(
                options.output,
                formatCodingTurnFooter(turnStartedAt, 'interrupted', 'interrupted by user'),
            );
            return;
        }
        case 'blocked_on_approval': {
            const reason = receipt.reason ?? 'approval required';
            emitTranscriptFallback(options.output, formatBlockedRunMessage(reason, receipt.toolCallId));
            emitTranscriptFallback(options.output, formatCodingTurnFooter(turnStartedAt, 'blocked', reason));
            return;
        }
        case 'failed': {
            const failedParts = settleTerminalToolTranscriptParts(renderState, 'failed');
            if (options.output.writeTranscriptPart !== undefined) {
                for (const part of failedParts) {
                    emitTranscriptPart(
                        options.output,
                        stampToolPartAttribution(part, renderState.lastAssistantAttributionId),
                        '',
                    );
                }
            }
            const reason = observabilityRedactor.redactText(receipt.reason ?? 'run failed');
            const fallbackText = `Error: ${reason}\n`;
            if (options.output.writeTranscriptPart === undefined) {
                emitTranscriptFallback(options.output, fallbackText);
            } else {
                const priorEmission =
                    renderState.lastGraphErrorEmission?.reason === reason
                        ? renderState.lastGraphErrorEmission
                        : undefined;
                const needsTypedPart = priorEmission?.typedPartEmitted !== true;
                const needsExactFallback = priorEmission?.exactReceiptFallbackWritten !== true;
                if (needsTypedPart) {
                    const receiptIdentity = receipt.runId ?? renderState.executionTurnId;
                    emitTranscriptPart(
                        options.output,
                        {
                            id: `receipt:${encodeURIComponent(receiptIdentity)}:error`,
                            type: 'error',
                            text: reason,
                            error: reason,
                            status: 'failed',
                        },
                        needsExactFallback ? fallbackText : '',
                    );
                } else if (needsExactFallback) {
                    emitTranscriptFallback(options.output, fallbackText);
                }
            }
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
            emitTranscriptFallback(options.output, formatCodingTurnFooter(turnStartedAt, 'failed', reason));
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
