import type { AgentEventEnvelope, AgentMessage, ModelProviderSelection } from '@mission-control/protocol';
import type { ProviderAdapter } from '../providers/provider-turn-types.js';
import type { AdmitPromptInput, SessionAdmissionEventStore } from '../session-admission-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export type RunCoordinatorStore = SessionAdmissionEventStore & {
    readonly appendEnvelopeWithStoreSequence?: (envelope: AgentEventEnvelope) => Promise<void>;
};

export type RunCoordinatorPromptInput = Omit<AdmitPromptInput, 'delivery' | 'inputId' | 'messageId'> & {
    readonly inputId?: string;
    readonly messageId?: string;
};

export type RunCoordinatorReadMessages = () => Promise<readonly AgentMessage[]>;

export type SessionRunCoordinatorOptions = {
    readonly sessionId: string;
    readonly store: RunCoordinatorStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now?: () => string;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly createId?: (prefix: string, index: number) => string;
    readonly readMessages?: RunCoordinatorReadMessages;
};

export function appendRunCoordinatorEnvelope(store: RunCoordinatorStore, envelope: AgentEventEnvelope): Promise<void> {
    return store.appendEnvelopeWithStoreSequence?.(envelope) ?? store.append(envelope.event);
}
