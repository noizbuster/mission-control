// allow: SIZE_OK -- the single-turn LLM actor owns provider streaming, retry, and post-stream tool settlement.
/**
 * LLMActor node (ABG §10.1) — wraps a Vercel AI SDK `streamText` call and exposes it as
 * an `AsyncIterable<AbgSignal>`, the universal ABG node contract.
 *
 * KEYSTONE CONSTRAINT (plan §5.2), made STRUCTURAL: every call hardcodes
 * `stopWhen: stepCountIs(1)`, so the SDK performs exactly ONE model call + ONE tool batch
 * per node execution. There is no override: the Observe→Decide→Act loop is owned by the
 * ABG graph (the coordinator's re-entry / driver loop in Phase 1), NOT by the SDK. With
 * the SDK's default multi-step loop, the SDK — not the graph — would be the decision
 * authority, hollowing out D1 and violating ABG §10.3. (In AI SDK v6, `maxSteps` was
 * removed; `stopWhen: stepCountIs(n)` is the equivalent. Whitelisted subagent loops are
 * a Phase 1 concern, reintroduced deliberately and tested.)
 *
 * Signals emitted:
 *   started, llm.turn.started (emit), … per-part deltas/proposals …,
 *   then EITHER llm.turn.completed (emit) + success   (on a completed turn)
 *   OR      llm.error (emit) + failure                  (on stream error / abort).
 * The node always reaches a terminal signal — it never hangs or rejects unhandled.
 */

import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { createObservabilityRedactor } from '../../../providers/observability-redactor';
import {
    abortableRetrySleep,
    computeProviderRetryDelayMs,
    DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
    DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS,
    isAbortRequested,
    isIndefiniteProviderWaitError,
} from '../../../providers/provider-retry-policy';
import {
    DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS,
    nextProviderChunkTimeoutMs,
} from '../../../providers/provider-turn-timeout';
import { ProviderTurnError } from '../../../providers/provider-turn-types';
import { errorToString } from '../../../util/error-to-string';
import { createAbgEmitSignal } from '../../abg-emit';
import type { CapturedToolProposal, ExecutedToolProposal } from './abg-tool-proposal-execution';
import { abgSignalsFromStreamPart, createStreamPartObservabilityState } from './ai-sdk-adapter';
import type { LlmActorRunInput, LlmActorTurnResult } from './llm-actor-node-types';
import {
    approvalBlockFailure,
    classifyProviderStreamError,
    extractProviderErrorCode,
    extractProviderErrorRetryable,
    extractProviderRetryExhausted,
    extractToolCallId,
    firstApprovalBlockedSettlementInProposalOrder,
    terminalToolFailure,
} from './llm-actor-settlements';

export type { LlmActorModel, LlmActorRunInput, LlmActorTurnResult } from './llm-actor-node-types';

const MAX_NO_OUTPUT_TIMEOUT_RETRIES = 3;

export async function* runLlmActor(input: LlmActorRunInput): AsyncIterable<AbgSignal> {
    const { nodeId, now } = input;
    const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const graphIdPart = input.graphId !== undefined ? { graphId: input.graphId } : {};

    yield { type: 'started', nodeId, ...graphIdPart };
    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.started',
        timestamp: now(),
    });

    let turnText = '';
    let turnUsage: unknown;
    let turnResponseMessages: readonly ModelMessage[] = [];
    let providerResponseMessages: readonly ModelMessage[] = [];
    const capturedToolProposals: CapturedToolProposal[] = [];
    // Track proposals in stream order so the approval-block check respects proposal order. The
    // SDK dispatches execute in non-deterministic order under a serialized batch; the ledger
    // records in completion order. Using the first-PROPOSED matches flat "first tool call" parity.
    const proposedToolCallIds: string[] = [];
    const retrySleep = input.retrySleep ?? abortableRetrySleep;
    const retryBaseDelayMs = input.retryBaseDelayMs ?? DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS;
    const maxRetryDelayMs = input.maxRetryDelayMs ?? DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS;
    let providerChunkTimeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS;
    let providerWaitAttempt = 0;
    let noOutputTimeoutRetries = 0;

    // Rate-limit / usage-exhaustion: wait indefinitely with exponential backoff (cap ~30m).
    // Only retry when no stream parts escaped — mid-stream failure must not re-execute tools.
    while (true) {
        let sawProviderOutput = false;
        let streamError: unknown;
        const attemptAbortController = new AbortController();
        const forwardAbort = () => {
            attemptAbortController.abort(input.signal?.reason);
        };
        if (input.signal?.aborted === true) {
            forwardAbort();
        } else {
            input.signal?.addEventListener('abort', forwardAbort, { once: true });
        }
        const adapterContext = {
            graphId: input.graphId,
            nodeId,
            now,
            ...(input.settlementLedger !== undefined ? { settlementLedger: input.settlementLedger } : {}),
            observabilityRedactor,
            observabilityStreams: createStreamPartObservabilityState(),
        };
        try {
            const noOutputDeadlineMs = Date.now() + providerChunkTimeoutMs;
            const result = streamText({
                model: input.model,
                system: input.system,
                messages: input.messages,
                // Runtime-authored system messages (yield reminders, mid-conversation context
                // updates) are placed in `messages` for chronological fidelity; safe to opt in.
                allowSystemInMessages: true,
                timeout: { chunkMs: providerChunkTimeoutMs },
                stopWhen: stepCountIs(1),
                // Own rate-limit waits below; disable AI SDK's short finite retry budget.
                maxRetries: 0,
                onError: () => undefined,
                ...(input.tools !== undefined ? { tools: input.tools } : {}),
                ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
                abortSignal: attemptAbortController.signal,
            });

            const streamIterator = result.fullStream[Symbol.asyncIterator]();
            while (true) {
                const next = sawProviderOutput
                    ? await streamIterator.next()
                    : await nextBeforeProviderOutput({
                          iterator: streamIterator,
                          signal: attemptAbortController.signal,
                          deadlineMs: noOutputDeadlineMs,
                          onTimeout: () => {
                              attemptAbortController.abort(providerTimeoutError());
                          },
                          timeoutError: providerTimeoutError,
                          abortError: () =>
                              input.signal?.aborted === true ? providerAbortedError() : providerTimeoutError(),
                      });
                if (next.done) {
                    break;
                }
                const part = next.value;
                if (part.type === 'error') {
                    streamError = part.error;
                    continue;
                }
                sawProviderOutput ||= isVisibleProviderOutput(part);
                if (input.settleToolProposals !== undefined && part.type === 'tool-call') {
                    capturedToolProposals.push({
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        argumentsJson: serializedToolInput(part.input),
                    });
                }
                for (const signal of abgSignalsFromStreamPart(part, adapterContext)) {
                    if (
                        signal.type === 'emit' &&
                        (signal.event.type === 'llm.text.delta' ||
                            signal.event.type === 'llm.reasoning.delta' ||
                            signal.event.type === 'llm.tool_call.proposed')
                    ) {
                        sawProviderOutput = true;
                    }
                    if (signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed') {
                        const proposedId = extractToolCallId(signal.event.payload);
                        if (proposedId !== undefined) {
                            proposedToolCallIds.push(proposedId);
                        }
                    }
                    yield signal;
                }
            }
            const [text, usage, response] = await Promise.all([result.text, result.usage, result.response]);
            turnText = text;
            turnUsage = usage;
            providerResponseMessages = response.messages;
            break;
        } catch (error) {
            const streamProviderError = streamError ?? error;
            const classified = classifyProviderStreamError(streamProviderError);
            const hasActionableStreamClassification = classified?.code !== undefined && classified.code !== 'unknown';
            const providerError =
                streamError !== undefined && !hasActionableStreamClassification ? error : streamProviderError;
            const streamMessage =
                streamProviderError instanceof Error ? streamProviderError.message : errorToString(streamProviderError);
            const surfacedMessage =
                providerError instanceof Error ? providerError.message : errorToString(providerError);
            const errorCode = hasActionableStreamClassification
                ? classified.code
                : extractProviderErrorCode(providerError);
            // `provider_aborted` is emitted by SDK adapters both for the run owner's AbortSignal
            // and for a remote transport that closed its request. Only the former is an interrupt.
            // A remote abort has no committed provider output yet, so retry it as a timeout instead
            // of terminally stopping the graph and orphaning the session.
            const externalProviderAbort = errorCode === 'provider_aborted' && !isAbortRequested(input.signal);
            const effectiveErrorCode = externalProviderAbort ? 'provider_timeout' : errorCode;
            const retryable = externalProviderAbort
                ? true
                : hasActionableStreamClassification
                  ? classified.retryable
                  : extractProviderErrorRetryable(providerError);
            const retryExhausted = extractProviderRetryExhausted(providerError);
            const eventErrorCode =
                hasActionableStreamClassification || externalProviderAbort || streamError === undefined
                    ? effectiveErrorCode
                    : undefined;
            const canRetryNoOutputTimeout =
                !externalProviderAbort &&
                input.timeoutMs === undefined &&
                effectiveErrorCode === 'provider_timeout' &&
                noOutputTimeoutRetries < MAX_NO_OUTPUT_TIMEOUT_RETRIES;
            if (
                !sawProviderOutput &&
                !isAbortRequested(input.signal) &&
                (isIndefiniteProviderWaitError(providerError) || canRetryNoOutputTimeout)
            ) {
                providerWaitAttempt += 1;
                const delayMs = computeProviderRetryDelayMs(providerWaitAttempt, retryBaseDelayMs, maxRetryDelayMs);
                if (canRetryNoOutputTimeout) {
                    noOutputTimeoutRetries += 1;
                    providerChunkTimeoutMs = nextProviderChunkTimeoutMs(providerChunkTimeoutMs);
                }
                yield createAbgEmitSignal({
                    graphId: input.graphId,
                    nodeId,
                    source: 'llm-actor',
                    eventType: 'llm.provider_wait',
                    payload: observabilityRedactor.redactValue({
                        attempt: providerWaitAttempt,
                        delayMs,
                        reason: effectiveErrorCode ?? 'provider_rate_limited',
                        message: observabilityRedactor.redactText(surfacedMessage),
                        chunkTimeoutMs: providerChunkTimeoutMs,
                    }),
                    timestamp: now(),
                });
                await retrySleep(delayMs, input.signal);
                if (isAbortRequested(input.signal)) {
                    yield createAbgEmitSignal({
                        graphId: input.graphId,
                        nodeId,
                        source: 'llm-actor',
                        eventType: 'llm.error',
                        payload: observabilityRedactor.redactValue({
                            error: 'provider turn aborted',
                            errorCode: 'provider_aborted',
                        }),
                        timestamp: now(),
                    });
                    yield {
                        type: 'failure',
                        nodeId,
                        ...graphIdPart,
                        error: observabilityRedactor.redactValue({
                            message: 'provider turn aborted',
                            code: 'provider_aborted',
                            providerError: true,
                            retryable: false,
                        }),
                    };
                    return;
                }
                continue;
            }

            // Redact credentials from the surfaced error message (parity with the flat path, which
            // redacts provider error messages at the provider-event layer) so a provider failure
            // carrying a secret does not leak into the `llm.error` emit (rendered + persisted).
            const message = observabilityRedactor.redactText(surfacedMessage);
            yield createAbgEmitSignal({
                graphId: input.graphId,
                nodeId,
                source: 'llm-actor',
                eventType: 'llm.error',
                payload: observabilityRedactor.redactValue({
                    error: observabilityRedactor.redactText(streamMessage),
                    ...(eventErrorCode !== undefined ? { errorCode: eventErrorCode } : {}),
                }),
                timestamp: now(),
            });
            // Structured provider failures carry code + retryable so the coordinator can retry
            // transient overload instead of treating missing retryable as terminal.
            yield {
                type: 'failure',
                nodeId,
                ...graphIdPart,
                error: observabilityRedactor.redactValue(
                    effectiveErrorCode !== undefined
                        ? {
                              message,
                              code: effectiveErrorCode,
                              providerError: true,
                              retryable: retryable ?? false,
                              ...(retryExhausted ? { retryExhausted: true } : {}),
                          }
                        : message,
                ),
            };
            return;
        } finally {
            input.signal?.removeEventListener('abort', forwardAbort);
        }
    }

    let settledToolProposals: readonly ExecutedToolProposal[];
    try {
        settledToolProposals =
            input.settleToolProposals === undefined ? [] : await input.settleToolProposals(capturedToolProposals);
    } catch (error) {
        const message = error instanceof Error ? error.message : errorToString(error);
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: observabilityRedactor.redactValue({
                message: `tool settlement failed: ${message}`,
                code: 'tool_settlement_failed',
                retryable: false,
            }),
        };
        return;
    }

    const quarantinedProposal = settledToolProposals.find((proposal) => proposal.commitState === 'quarantined');
    if (quarantinedProposal !== undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: observabilityRedactor.redactValue({
                message: `tool settlement quarantined: ${quarantinedProposal.settlement.toolCallId}`,
                code: 'tool_settlement_quarantined',
                retryable: false,
            }),
        };
        return;
    }

    for (const settledProposal of settledToolProposals) {
        yield toolSettlementSignal(input, settledProposal);
    }
    turnResponseMessages = [...providerResponseMessages, ...toolResultMessages(settledToolProposals)];

    // Approval-block short-circuit: if a tool settled as `approval_required` (a permission gate
    // in `block` mode with no automation), the graph must settle as `blocked` — parity with the
    // flat run coordinator's `approvalBlockedSettlement` detection. Surfacing the block to the
    // model instead would make it retry the same call until the loop budget is exhausted. Emit a
    // `failure` carrying the `tool_approval_blocked` code + toolCallId so the coordinator settles
    // the graph as `blocked` (not retried as a hard failure). The gate already emitted the
    // `approval.requested`/`approval.blocked` events through the registry, so no duplicate emit.
    const approvalBlock = firstApprovalBlockedSettlementInProposalOrder(input.settlementLedger, proposedToolCallIds);
    if (approvalBlock !== undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: observabilityRedactor.redactValue(approvalBlockFailure(approvalBlock)),
        };
        return;
    }

    // A tool that settled `approval_denied` (the user denied the permission gate) is intentionally
    // NOT short-circuited. The bridge surfaces the denial to the model as a readable tool-result
    // string, so the re-entry loop feeds it back and the model can adapt. A single read-only-tool
    // denial must not terminate a long multi-step run. Retry is bounded by `maxNodeRuns`.

    // Terminal tool-failure short-circuit: when `haltOnFailedToolSettlement` is set, a tool that
    // settled `failed` for a NON-approval reason (e.g. `command_not_allowed` — a non-allowlisted
    // command the model cannot fix by retrying) terminates the run — parity with the flat run
    // coordinator's `haltOnFailedToolSettlement` / `terminalFailedSettlement`. Surfacing an
    // unfixable error would otherwise make the model retry the same call until the node-run budget
    // is exhausted. Emit a `failure` carrying `tool_settlement_failed` + toolCallId so the node
    // runner marks it terminal (no retry) and the coordinator fails the run immediately.
    if (input.haltOnFailedToolSettlement === true) {
        const terminalFailure = input.settlementLedger?.terminalFailedSettlement();
        if (terminalFailure !== undefined) {
            yield {
                type: 'failure',
                nodeId,
                ...graphIdPart,
                error: observabilityRedactor.redactValue(terminalToolFailure(terminalFailure)),
            };
            return;
        }
    }

    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.completed',
        timestamp: now(),
        payload: observabilityRedactor.redactValue({ text: turnText, usage: turnUsage }),
    });
    const rawTurnResult: LlmActorTurnResult = {
        text: turnText,
        usage: turnUsage,
        responseMessages: turnResponseMessages,
    };
    input.captureRawTurnResult?.(rawTurnResult);
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: observabilityRedactor.redactValue(rawTurnResult),
    };
}

type NextBeforeProviderOutputInput<Part> = {
    readonly iterator: AsyncIterator<Part>;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
    readonly onTimeout: () => void;
    readonly timeoutError: () => ProviderTurnError;
    readonly abortError: () => ProviderTurnError;
};

function nextBeforeProviderOutput<Part>(input: NextBeforeProviderOutputInput<Part>): Promise<IteratorResult<Part>> {
    if (input.signal.aborted) {
        return Promise.reject(input.abortError());
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const clear = () => {
            clearTimeout(timeout);
            input.signal.removeEventListener('abort', abort);
        };
        const fail = (error: ProviderTurnError) => {
            if (settled) return;
            settled = true;
            clear();
            reject(error);
        };
        const timeout = setTimeout(
            () => {
                input.onTimeout();
                fail(input.timeoutError());
            },
            Math.max(0, input.deadlineMs - Date.now()),
        );
        const abort = () => {
            fail(input.abortError());
        };
        input.signal.addEventListener('abort', abort, { once: true });
        input.iterator.next().then(
            (result) => {
                if (settled) return;
                settled = true;
                clear();
                resolve(result);
            },
            (error: unknown) => {
                if (settled) return;
                settled = true;
                clear();
                reject(error);
            },
        );
    });
}

function isVisibleProviderOutput(part: { readonly type: string }): boolean {
    return part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-call';
}

function providerTimeoutError(): ProviderTurnError {
    return new ProviderTurnError({
        code: 'provider_timeout',
        message: 'provider turn timed out',
        retryable: true,
    });
}

function providerAbortedError(): ProviderTurnError {
    return new ProviderTurnError({
        code: 'provider_aborted',
        message: 'provider turn aborted',
        retryable: false,
    });
}

function serializedToolInput(input: unknown): string {
    if (typeof input === 'string') return input;
    return JSON.stringify(input) ?? 'null';
}

function toolSettlementSignal(input: LlmActorRunInput, settledProposal: ExecutedToolProposal): AbgSignal {
    const eventType = settledProposal.settlement.status === 'completed' ? 'tool.completed' : 'tool.failed';
    const payload =
        settledProposal.settlement.status === 'completed'
            ? {
                  toolCallId: settledProposal.settlement.toolCallId,
                  toolName: settledProposal.settlement.toolName,
                  ...(settledProposal.settlement.output !== undefined
                      ? { output: settledProposal.settlement.output }
                      : {}),
                  ...(settledProposal.settlement.structuredOutput !== undefined
                      ? { structuredOutput: settledProposal.settlement.structuredOutput }
                      : {}),
              }
            : {
                  toolCallId: settledProposal.settlement.toolCallId,
                  toolName: settledProposal.settlement.toolName,
                  ...(settledProposal.settlement.error !== undefined
                      ? { error: settledProposal.settlement.error }
                      : {}),
              };
    return createAbgEmitSignal({
        graphId: input.graphId,
        nodeId: input.nodeId,
        source: 'llm-actor',
        eventType,
        timestamp: input.now(),
        payload,
    });
}

function toolResultMessages(settledProposals: readonly ExecutedToolProposal[]): readonly ModelMessage[] {
    return settledProposals.map(
        (settledProposal): ModelMessage => ({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: settledProposal.settlement.toolCallId,
                    toolName: settledProposal.settlement.toolName,
                    output:
                        settledProposal.settlement.status === 'completed'
                            ? { type: 'text', value: settledProposal.modelOutput }
                            : { type: 'error-text', value: settledProposal.modelOutput },
                },
            ],
        }),
    );
}
