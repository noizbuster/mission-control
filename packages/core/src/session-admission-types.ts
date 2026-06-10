import type { AgentEvent } from '@mission-control/protocol';

export type PromptDeliveryMode = 'steer' | 'queue';
export type PromptPromotionTrigger = 'wake' | 'run';

export type AdmitPromptInput = {
    readonly inputId: string;
    readonly messageId: string;
    readonly prompt: string;
    readonly delivery: PromptDeliveryMode;
    readonly parentMessageId?: string;
    readonly resume?: boolean;
    readonly providerTurnId?: string;
    readonly toolCallId?: string;
    readonly graphId?: string;
    readonly nodeId?: string;
};

export type PromptAdmissionReceipt = {
    readonly inputId: string;
    readonly messageId: string;
    readonly delivery: PromptDeliveryMode;
    readonly scheduledWake: boolean;
};

export type PromptInputState = Omit<AdmitPromptInput, 'resume'> & {
    readonly admittedAt: string;
};

export type ModelVisibleTranscriptMessage = {
    readonly messageId: string;
    readonly role: 'user';
    readonly content: string;
    readonly promotedAt: string;
    readonly inputId: string;
    readonly delivery: PromptDeliveryMode;
    readonly parentMessageId?: string;
    readonly providerTurnId?: string;
    readonly toolCallId?: string;
    readonly graphId?: string;
    readonly nodeId?: string;
};

export type TranscriptBranchNode = {
    readonly messageId: string;
    readonly parentMessageId?: string;
    readonly childMessageIds: readonly string[];
};

export type TranscriptBranchTree = {
    readonly activeLeafMessageId?: string;
    readonly nodes: readonly TranscriptBranchNode[];
};

export type SessionAdmissionProjection = {
    readonly sessionId: string;
    readonly admittedInputs: readonly PromptInputState[];
    readonly pendingInputs: readonly PromptInputState[];
    readonly steeringInputs: readonly PromptInputState[];
    readonly queuedInputs: readonly PromptInputState[];
    readonly modelVisibleMessages: readonly ModelVisibleTranscriptMessage[];
    readonly branchTree: TranscriptBranchTree;
};

export type PromptPromotionResult =
    | {
          readonly kind: 'promoted';
          readonly trigger: PromptPromotionTrigger;
          readonly inputId: string;
          readonly messageId: string;
      }
    | {
          readonly kind: 'idle';
      }
    | {
          readonly kind: 'run_requested';
      };

export type SessionAdmissionEventStore = {
    readonly append: (event: AgentEvent) => Promise<void>;
    readonly getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
};
