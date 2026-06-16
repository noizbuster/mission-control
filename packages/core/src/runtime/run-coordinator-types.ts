import type {
    AgentEvent,
    AgentEventEnvelope,
    AgentMessage,
    ModelProviderSelection,
    ToolCall,
} from '@mission-control/protocol';
import type { ProjectContextMessageOptions } from '../context/project-context-messages.js';
import type { ProviderAdapter } from '../providers/provider-turn-types.js';
import type { AdmitPromptInput, SessionAdmissionEventStore } from '../session-admission-types.js';
import type { ToolInvocationSettlement, ToolRegistry } from '../tools/tool-registry.js';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle.js';

export type RunCoordinatorStore = SessionAdmissionEventStore & {
    readonly appendEnvelopeWithStoreSequence?: (envelope: AgentEventEnvelope) => Promise<void>;
};

export type RunCoordinatorPromptInput = Omit<AdmitPromptInput, 'delivery' | 'inputId' | 'messageId'> & {
    readonly inputId?: string;
    readonly messageId?: string;
};

export type RunCoordinatorReadMessages = () => Promise<readonly AgentMessage[]>;
export type RunCoordinatorEventObserver = (event: AgentEvent) => Promise<void> | void;
export type RunCoordinatorEnvelopeObserver = (envelope: AgentEventEnvelope) => Promise<void> | void;
export type RunCoordinatorToolCallResult = ToolInvocationSettlement | undefined;
export type RunCoordinatorToolCallObserver = (
    toolCall: ToolCall,
) => Promise<RunCoordinatorToolCallResult> | RunCoordinatorToolCallResult;
export type RunCoordinatorToolSettlementObserver = (settlement: ToolInvocationSettlement) => Promise<void> | void;

/**
 * The coordinator-facing context handed to a turn runner on each promoted input. Engine-agnostic:
 * the flat provider loop and the ABG graph runner both consume the same admitted-message source,
 * durability sinks, and observer hooks. The coordinator owns promotion/queue/resume; the runner
 * owns one model turn (flat) or one graph run (graph) and reports its terminal status.
 */
export type RunCoordinatorTurnContext = {
    readonly signal: AbortSignal;
    readonly readMessages: () => Promise<readonly AgentMessage[]>;
    readonly nextId: (prefix: string) => Promise<string>;
    readonly appendDurableEvent: (event: AgentEvent) => Promise<void>;
    readonly appendDurableEnvelope: (envelope: AgentEventEnvelope) => Promise<void>;
    readonly onProviderEnvelope?: RunCoordinatorEnvelopeObserver;
    readonly onToolCall?: RunCoordinatorToolCallObserver;
    readonly onToolSettlement?: RunCoordinatorToolSettlementObserver;
};

/**
 * A pluggable turn runner. The default (omitted) drives the flat provider tool loop; an injected
 * runner (e.g. `createGraphTurnRunner`) drives the ABG graph. Both return the same terminal-result
 * shape so the drain loop's promotion/finalize logic is shared.
 */
export type RunCoordinatorTurnRunner = (
    context: RunCoordinatorTurnContext,
) => Promise<RunCoordinatorProviderTurnResult>;

export type SessionRunCoordinatorOptions = {
    readonly sessionId: string;
    readonly store: RunCoordinatorStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now?: () => string;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly haltOnFailedToolSettlement?: boolean;
    readonly projectContext?: ProjectContextMessageOptions;
    readonly toolRegistry?: ToolRegistry;
    readonly createId?: (prefix: string, index: number) => string;
    readonly readMessages?: RunCoordinatorReadMessages;
    readonly onDurableEvent?: RunCoordinatorEventObserver;
    readonly onProviderEnvelope?: RunCoordinatorEnvelopeObserver;
    readonly onToolCall?: RunCoordinatorToolCallObserver;
    readonly onToolSettlement?: RunCoordinatorToolSettlementObserver;
    /**
     * Engine selector. Omit (default) to drive the flat provider tool loop. Inject a runner
     * (e.g. `createGraphTurnRunner`) to drive the ABG coding-agent graph instead. The flat path
     * is byte-identical when this is omitted.
     */
    readonly runProviderTurn?: RunCoordinatorTurnRunner;
};

export function appendRunCoordinatorEnvelope(store: RunCoordinatorStore, envelope: AgentEventEnvelope): Promise<void> {
    return store.appendEnvelopeWithStoreSequence?.(envelope) ?? store.append(envelope.event);
}
