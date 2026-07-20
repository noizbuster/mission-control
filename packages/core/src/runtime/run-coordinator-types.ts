import type {
    AgentEvent,
    AgentEventEnvelope,
    AgentMessage,
    ModelProviderSelection,
    ToolCall,
} from '@mission-control/protocol';
import type { ProjectContextMessageOptions } from '../context/project-context-messages';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import type { ProviderAdapter } from '../providers/provider-turn-types';
import type { AdmitPromptInput, SessionAdmissionEventStore } from '../session-admission-types';
import type { ToolInvocationSettlement, ToolRegistry } from '../tools/tool-registry';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle';
import type { SessionControlHost } from './session-control-host';

export type RunCoordinatorStore = SessionAdmissionEventStore & {
    readonly appendEnvelopeWithStoreSequence?: (envelope: AgentEventEnvelope) => Promise<void>;
    /**
     * Optional batch append used by graph turn flush. Implementations should serialize the batch
     * through one write-lane transaction and stop early when `signal` is aborted.
     */
    readonly appendMany?: (events: readonly AgentEvent[], signal?: AbortSignal) => Promise<void>;
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
 * Drain command that opened the current turn. The graph turn runner seeds a durable
 * `resumeCheckpoint` only when this is `'resume'`; normal `'run'` / `'wake'` turns always start
 * fresh even if the session ledger still holds an older checkpoint.
 */
export type RunCoordinatorTurnCommand = 'wake' | 'run' | 'resume';

/**
 * The coordinator-facing context handed to a turn runner on each promoted input. Engine-agnostic:
 * the flat provider loop and the ABG graph runner both consume the same admitted-message source,
 * durability sinks, and observer hooks. The coordinator owns promotion/queue/resume; the runner
 * owns one model turn (flat) or one graph run (graph) and reports its terminal status.
 */
export type RunCoordinatorTurnContext = {
    readonly signal: AbortSignal;
    readonly command: RunCoordinatorTurnCommand;
    readonly readMessages: () => Promise<readonly AgentMessage[]>;
    /**
     * Cold session event ledger for resume loaders (`findResumableRun` / checkpoint parse). The
     * engine always supplies this from the durable store; stub tests may omit it when not exercising
     * resume seeding.
     */
    readonly readSessionEvents?: () => Promise<readonly AgentEvent[]>;
    readonly nextId: (prefix: string) => Promise<string>;
    readonly appendDurableEvent: (event: AgentEvent) => Promise<void>;
    /**
     * Optional batch durable append. Implementations should use a single write-lane transaction for
     * the whole batch and honor `signal` between items so interrupt can stop a multi-minute drain.
     */
    readonly appendDurableEvents?: (events: readonly AgentEvent[], signal?: AbortSignal) => Promise<void>;
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
    readonly sessionControlHost?: SessionControlHost;
    readonly observabilityRedactor?: ObservabilityRedactor;
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
