// allow: SIZE_OK -- graph-owned settlement keeps proposal execution, callback fencing, and durable event commitment together.
import type { AgentEvent, ProtocolError, ToolResultStatus } from '@mission-control/protocol';
import type { SessionControlEpoch } from '../../../runtime/session-control-cancellation';
import type { ToolRegistry } from '../../../tools/tool-registry';
import type { ToolAdvertisement, ToolInvocationSettlement } from '../../../tools/tool-registry-types';
import { errorToString } from '../../../util/error-to-string';

export type PolicyGateDecision = {
    readonly allowed: boolean;
    readonly reason?: string;
};

export type PolicyGateInput = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
};

export type PolicyGateFn = (input: PolicyGateInput) => Promise<PolicyGateDecision>;

export type PolicyDecisionObserverInput = PolicyGateDecision & {
    readonly toolCallId: string;
    readonly toolName: string;
};

export type AbgToolSettlement = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: ToolResultStatus;
    readonly output?: unknown;
    readonly structuredOutput?: unknown;
    readonly error?: ProtocolError;
};

export type AbgToolSettlementLedger = {
    readonly record: (settlement: AbgToolSettlement) => void;
    readonly lookup: (toolCallId: string) => AbgToolSettlement | undefined;
    readonly approvalBlockedSettlement: () => AbgToolSettlement | undefined;
    readonly deniedSettlement: () => AbgToolSettlement | undefined;
    readonly terminalFailedSettlement: () => AbgToolSettlement | undefined;
};

export function createAbgToolSettlementLedger(): AbgToolSettlementLedger {
    const entries = new Map<string, AbgToolSettlement>();
    return {
        record: (settlement) => {
            entries.set(settlement.toolCallId, settlement);
        },
        lookup: (toolCallId) => entries.get(toolCallId),
        approvalBlockedSettlement: () => firstMatchingSettlement(entries, isApprovalRequiredSettlement),
        deniedSettlement: () => firstMatchingSettlement(entries, isApprovalDeniedSettlement),
        terminalFailedSettlement: () => firstMatchingSettlement(entries, isTerminalFailedSettlement),
    };
}

export function isApprovalRequiredSettlement(settlement: AbgToolSettlement): boolean {
    return settlement.status === 'failed' && (settlement.error?.message ?? '').startsWith('approval_required:');
}

export function isApprovalDeniedSettlement(settlement: AbgToolSettlement): boolean {
    return settlement.status === 'failed' && (settlement.error?.message ?? '').startsWith('approval_denied:');
}

export function isTerminalFailedSettlement(settlement: AbgToolSettlement): boolean {
    return (
        settlement.status === 'failed' &&
        !isApprovalRequiredSettlement(settlement) &&
        !isApprovalDeniedSettlement(settlement) &&
        settlement.error?.retryable !== true
    );
}

export type AbgToolBridgeOptions = {
    readonly policyGate?: PolicyGateFn;
    readonly onPolicyDecision?: (decision: PolicyDecisionObserverInput) => void;
    readonly settlementLedger?: AbgToolSettlementLedger;
    readonly onToolEvent?: (event: AgentEvent) => void;
    readonly serializeToolExecution?: boolean;
    readonly controlEpoch?: SessionControlEpoch;
};

export type CapturedToolProposal = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
};

export type ExecutedToolProposal = {
    readonly commitState: 'committed' | 'quarantined';
    readonly settlement: AbgToolSettlement;
    readonly modelOutput: string;
};

export type ToolProposalExecutor = {
    readonly execute: (
        proposals: readonly CapturedToolProposal[],
        signal: AbortSignal | undefined,
    ) => Promise<readonly ExecutedToolProposal[]>;
};

type ToolExecutionLock = {
    readonly acquire: () => Promise<() => void>;
};

type ToolProposalExecutionMode = 'legacy' | 'proposal-only';

export function createToolProposalExecutor(
    registry: ToolRegistry,
    advertisements: readonly ToolAdvertisement[],
    options: AbgToolBridgeOptions = {},
    mode: ToolProposalExecutionMode = 'legacy',
): ToolProposalExecutor {
    const advertisementByName = new Map(advertisements.map((advertisement) => [advertisement.name, advertisement]));
    const lock = options.serializeToolExecution === true ? createAsyncMutex() : undefined;
    return {
        execute: async (proposals, signal) => {
            const outcomes = await Promise.allSettled(
                proposals.map(async (proposal) => {
                    const advertisement = advertisementByName.get(proposal.toolName);
                    if (advertisement === undefined) {
                        const settlement = missingAdvertisementSettlement(proposal);
                        options.settlementLedger?.record(settlement);
                        return {
                            commitState: 'committed' as const,
                            settlement,
                            modelOutput: failedModelOutput(proposal.toolName, settlement.error),
                        };
                    }
                    return executeProposal(registry, advertisement, proposal, signal, options, lock, mode);
                }),
            );
            const settled: ExecutedToolProposal[] = [];
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') throw outcome.reason;
                settled.push(outcome.value);
            }
            return settled;
        },
    };
}

async function executeProposal(
    registry: ToolRegistry,
    advertisement: ToolAdvertisement,
    proposal: CapturedToolProposal,
    signal: AbortSignal | undefined,
    options: AbgToolBridgeOptions,
    lock: ToolExecutionLock | undefined,
    mode: ToolProposalExecutionMode,
): Promise<ExecutedToolProposal> {
    const release = lock !== undefined ? await lock.acquire() : undefined;
    try {
        if (options.policyGate !== undefined) {
            const decision = await options.policyGate(proposal);
            options.onPolicyDecision?.({ ...decision, toolCallId: proposal.toolCallId, toolName: proposal.toolName });
            if (!decision.allowed) {
                const settlement = policyDeniedSettlement(proposal, decision.reason);
                options.settlementLedger?.record(settlement);
                return {
                    commitState: 'committed',
                    settlement,
                    modelOutput: failedModelOutput(proposal.toolName, settlement.error),
                };
            }
        }

        const controlled = options.controlEpoch?.callbackFence !== undefined;
        let committedSettlement: ToolInvocationSettlement | undefined;
        let invoked: ToolInvocationSettlement;
        try {
            invoked = await registry.invoke({
                toolCallId: proposal.toolCallId,
                toolName: proposal.toolName,
                advertisedVersion: advertisement.version,
                argumentsJson: proposal.argumentsJson,
                ...(signal !== undefined ? { signal } : {}),
                ...(options.controlEpoch !== undefined ? { controlEpoch: options.controlEpoch } : {}),
                ...(controlled && (options.settlementLedger !== undefined || options.onToolEvent !== undefined)
                    ? {
                          writeSettlement: (terminal: ToolInvocationSettlement) => {
                              committedSettlement = terminal;
                              return Promise.resolve();
                          },
                      }
                    : {}),
            });
        } catch (error) {
            if (mode === 'legacy') throw error;
            const settlement = unexpectedToolFailureSettlement(proposal, error);
            if (!controlled) options.settlementLedger?.record(settlement);
            return {
                commitState: controlled ? 'quarantined' : 'committed',
                settlement,
                modelOutput: failedModelOutput(proposal.toolName, settlement.error),
            };
        }
        const settlementToPublish = controlled ? committedSettlement : invoked;
        const settlement = settlementToLedgerEntry(proposal, settlementToPublish ?? invoked);
        if (settlementToPublish !== undefined) {
            publishSettlement(settlementToPublish, settlement, options);
        }
        return {
            commitState: controlled && committedSettlement === undefined ? 'quarantined' : 'committed',
            settlement,
            modelOutput: modelOutputFor(invoked),
        };
    } finally {
        release?.();
    }
}

function firstMatchingSettlement(
    entries: ReadonlyMap<string, AbgToolSettlement>,
    predicate: (settlement: AbgToolSettlement) => boolean,
): AbgToolSettlement | undefined {
    for (const settlement of entries.values()) {
        if (predicate(settlement)) return settlement;
    }
    return undefined;
}

function createAsyncMutex(): ToolExecutionLock {
    let chain: Promise<unknown> = Promise.resolve();
    return {
        acquire: () =>
            new Promise<() => void>((resolveAcquire) => {
                chain = chain.then(
                    () =>
                        new Promise<void>((resolveHold) => {
                            resolveAcquire(() => resolveHold());
                        }),
                );
            }),
    };
}

function policyDeniedSettlement(proposal: CapturedToolProposal, reason: string | undefined): AbgToolSettlement {
    const suffix = reason === undefined ? '' : `: ${reason}`;
    return {
        toolCallId: proposal.toolCallId,
        toolName: proposal.toolName,
        status: 'failed',
        error: { code: 'unknown', message: `BLOCKED by policy gate${suffix}`, retryable: false },
    };
}

function missingAdvertisementSettlement(proposal: CapturedToolProposal): AbgToolSettlement {
    return {
        toolCallId: proposal.toolCallId,
        toolName: proposal.toolName,
        status: 'failed',
        error: { code: 'tool_failed', message: `tool is no longer advertised: ${proposal.toolName}`, retryable: false },
    };
}

function unexpectedToolFailureSettlement(proposal: CapturedToolProposal, error: unknown): AbgToolSettlement {
    return {
        toolCallId: proposal.toolCallId,
        toolName: proposal.toolName,
        status: 'failed',
        error: { code: 'tool_failed', message: errorToString(error), retryable: false },
    };
}

function publishSettlement(
    invoked: ToolInvocationSettlement,
    settlement: AbgToolSettlement,
    options: AbgToolBridgeOptions,
): void {
    if (options.onToolEvent !== undefined) {
        for (const event of invoked.events) {
            if (!isAdapterOwnedToolLifecycle(event.type)) options.onToolEvent(event);
        }
    }
    options.settlementLedger?.record(settlement);
}

function settlementToLedgerEntry(
    proposal: CapturedToolProposal,
    settlement: ToolInvocationSettlement,
): AbgToolSettlement {
    if (settlement.result.status === 'completed') {
        return {
            toolCallId: proposal.toolCallId,
            toolName: proposal.toolName,
            status: 'completed',
            ...(settlement.result.output !== undefined ? { output: settlement.result.output } : {}),
            ...(settlement.structuredOutput !== undefined ? { structuredOutput: settlement.structuredOutput } : {}),
        };
    }
    return {
        toolCallId: proposal.toolCallId,
        toolName: proposal.toolName,
        status: 'failed',
        error: settlement.result.error ?? {
            code: 'tool_failed',
            message: 'tool produced no model output',
            retryable: false,
        },
    };
}

function modelOutputFor(settlement: ToolInvocationSettlement): string {
    if (settlement.modelOutput !== undefined) return settlement.modelOutput.content;
    return failedModelOutput(settlement.toolName, settlement.result.error);
}

function failedModelOutput(toolName: string, error: ProtocolError | undefined): string {
    const code = error?.code ?? 'tool_failed';
    const message = error?.message ?? 'tool produced no model output';
    return `Tool "${toolName}" failed (${code}): ${message}`;
}

function isAdapterOwnedToolLifecycle(eventType: AgentEvent['type']): boolean {
    return eventType === 'tool.started' || eventType === 'tool.completed' || eventType === 'tool.failed';
}
