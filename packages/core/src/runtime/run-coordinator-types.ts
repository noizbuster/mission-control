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
};

export function appendRunCoordinatorEnvelope(store: RunCoordinatorStore, envelope: AgentEventEnvelope): Promise<void> {
    return store.appendEnvelopeWithStoreSequence?.(envelope) ?? store.append(envelope.event);
}
