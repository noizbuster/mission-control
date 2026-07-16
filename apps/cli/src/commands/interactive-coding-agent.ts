import {
    createObservabilityRedactor,
    createProviderAuthStoreObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventForObservability,
    type SessionRunOwner,
    type SessionRunOwnerReceipt,
} from '@mission-control/core';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';
import type { ActiveCodingAgentTurn, CodingAgentTurnOptions } from './interactive-coding-agent-types';
import type { ProviderRenderState } from './interactive-coding-graph-rendering';
import { createInteractiveRunOwner } from './interactive-coding-run-owner';
import { emitInteractiveTaskEvent, runOwnedCodingAgentTurn } from './interactive-coding-run-settlement';
import { closeProductionToolRegistry } from './production-tool-registry';

export type {
    ActiveCodingAgentTurn,
    ActiveCodingAgentTurnOutcome,
    CodingAgentTurnOptions,
    InterruptMode,
} from './interactive-coding-agent-types';
export { interactiveGraphStreamSignal } from './interactive-coding-graph-rendering';
export { type AbgOverlayWiring, wireAbgOverlay } from './interactive-coding-overlay';
export { formatToolCountSummary } from './interactive-coding-signal-payload';

export async function startCodingAgentTurn(options: CodingAgentTurnOptions): Promise<ActiveCodingAgentTurn> {
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: `user prompt: ${options.prompt}`,
        execute: (owner) =>
            owner.submit({
                prompt: options.prompt,
                inputId: `input_${options.turnId}`,
                messageId: `message_${options.turnId}`,
            }),
    });
}

export async function resumeCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'>,
): Promise<ActiveCodingAgentTurn> {
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: 'resume blocked run',
        execute: (owner) => owner.resume(),
    });
}

async function startOwnedCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    action: {
        readonly taskStartedMessage: string;
        readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
    },
): Promise<ActiveCodingAgentTurn> {
    let activeApprovalRedactor =
        options.authStore === undefined
            ? createObservabilityRedactor()
            : await createProviderAuthStoreObservabilityRedactor(options.authStore);
    const approvalRedactor: ObservabilityRedactor = {
        redactText: (text) => activeApprovalRedactor.redactText(text),
        redactIdentifier: (identifier) => activeApprovalRedactor.redactIdentifier(identifier),
        redactValue: (value) => activeApprovalRedactor.redactValue(value),
        createTextStream: () => activeApprovalRedactor.createTextStream(),
    };
    const approvals = createInteractiveApprovalBroker(
        { ...options, observabilityRedactor: approvalRedactor },
        options.permissionSession,
    );
    const renderState: ProviderRenderState = {
        streamingText: false,
        streamingThinking: false,
        toolCount: 0,
        toolNames: [],
    };
    const { owner, tools, observabilityRedactor, overlayWiring } = await createInteractiveRunOwner(
        options,
        approvals,
        renderState,
    );
    activeApprovalRedactor = observabilityRedactor;
    let settled = false;
    const outcome = runOwnedCodingAgentTurn(options, owner, renderState, action, approvalRedactor)
        .catch((error: unknown) => {
            const message = approvalRedactor.redactText(error instanceof Error ? error.message : String(error));
            options.output.write(`Error: ${message}\n`);
            settleCrashedCodingTurn(options, message, approvalRedactor, owner.status().runId);
            return 'failed' as const;
        })
        .finally(async () => {
            settled = true;
            try {
                await owner.release();
            } finally {
                try {
                    await closeProductionToolRegistry(tools);
                } finally {
                    overlayWiring?.dispose();
                }
            }
        });
    const done = outcome.then(() => undefined);

    return {
        done,
        outcome,
        interrupt: () => {
            approvals.cancel('interrupted by user');
            interruptOwnerUntilSettled(owner, () => settled);
        },
        answerApproval: approvals.answer,
        hasPendingApproval: approvals.hasPending,
        setApprovalLevel: approvals.setApprovalLevel,
    };
}

function interruptOwnerUntilSettled(owner: SessionRunOwner, isSettled: () => boolean): void {
    const interrupt = () => {
        if (!isSettled()) {
            void owner.interrupt('interrupted by user');
        }
    };
    interrupt();
    for (const delayMs of [0, 5, 25]) {
        setTimeout(interrupt, delayMs);
    }
}

function settleCrashedCodingTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    message: string,
    observabilityRedactor: ObservabilityRedactor,
    runId: string | undefined,
): void {
    const timestamp = new Date().toISOString();
    const run = {
        command: 'run' as const,
        state: 'failed' as const,
        reason: message,
        ...(runId !== undefined ? { runId } : {}),
    };
    options.emitEvent(
        redactAgentEventForObservability(
            {
                type: 'run.failed',
                timestamp,
                sessionId: options.sessionId,
                message,
                run,
            },
            observabilityRedactor,
        ),
    );
    emitInteractiveTaskEvent(
        options,
        {
            type: 'task.failed',
            message,
            run,
        },
        observabilityRedactor,
    );
}
