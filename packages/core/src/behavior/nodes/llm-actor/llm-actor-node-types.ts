import type { ModelMessage, streamText, ToolSet } from 'ai';
import type { ObservabilityRedactor } from '../../../providers/observability-redactor';
import type { AbgToolSettlementLedger } from './abg-tool-bridge';
import type { CapturedToolProposal, ExecutedToolProposal } from './abg-tool-proposal-execution';

type StreamTextParameters = Parameters<typeof streamText>[0];

/** The Vercel AI SDK model type accepted by `streamText({ model })`. */
export type LlmActorModel = StreamTextParameters['model'];

export type LlmActorTurnResult = {
    readonly text: string;
    readonly usage: unknown;
    readonly responseMessages: readonly ModelMessage[];
};

export type LlmActorRunInput = {
    readonly graphId?: string;
    readonly nodeId: string;
    readonly model: LlmActorModel;
    readonly system: string;
    readonly messages: NonNullable<StreamTextParameters['messages']>;
    readonly tools?: ToolSet;
    readonly toolChoice?: NonNullable<StreamTextParameters['toolChoice']>;
    readonly signal?: AbortSignal;
    /** Per-chunk provider stream timeout (ms). Bounds hung real-provider SSE connections. */
    readonly timeoutMs?: number;
    readonly now: () => string;
    readonly settlementLedger?: AbgToolSettlementLedger;
    readonly settleToolProposals?: (
        proposals: readonly CapturedToolProposal[],
    ) => Promise<readonly ExecutedToolProposal[]>;
    readonly haltOnFailedToolSettlement?: boolean;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly captureRawTurnResult?: (result: LlmActorTurnResult) => void;
    readonly retrySleep?: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
    readonly retryBaseDelayMs?: number;
    readonly maxRetryDelayMs?: number;
};
