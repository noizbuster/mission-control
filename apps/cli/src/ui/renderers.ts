import type { AgentRuntime } from '@mission-control/core';
import type {
    AgentEvent,
    ApprovalLifecycleState,
    ModelProviderSelection,
    RunCoordinatorState,
} from '@mission-control/protocol';
import type { AgentUIRenderer } from './ui-adapter.js';

type JsonOutputStatus = RunCoordinatorState;

type JsonMachineToolState = {
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly status: 'pending' | 'completed' | 'failed';
};

type JsonMachineApprovalState = {
    readonly approvalId: string;
    readonly state: ApprovalLifecycleState;
    readonly toolCallId?: string;
    readonly resumable: boolean;
};

type JsonMachineRunState = {
    readonly runId?: string;
    readonly status: JsonOutputStatus;
    readonly toolCallId?: string;
};

type JsonMachineSessionState = {
    readonly sessionId: string;
    readonly stopped: boolean;
};

type JsonMachineState = {
    readonly session: JsonMachineSessionState;
    readonly run?: JsonMachineRunState;
    readonly tool?: JsonMachineToolState;
    readonly approval?: JsonMachineApprovalState;
};

type JsonOutputRecord = AgentEvent & {
    readonly status: JsonOutputStatus;
    readonly runId?: string;
    readonly toolCallId?: string;
    readonly approvalId?: string;
    readonly machine: JsonMachineState;
};

abstract class BufferedRenderer implements AgentUIRenderer {
    protected readonly events: AgentEvent[] = [];

    async start(_runtime: AgentRuntime): Promise<void> {}

    render(event: AgentEvent): void {
        this.events.push(event);
    }

    async stop(): Promise<void> {}

    abstract getOutput(): string;

    protected get sessionId(): string {
        return this.events.find((event) => event.sessionId !== undefined)?.sessionId ?? 'unknown';
    }

    protected get lastMessage(): string {
        return (
            [...this.events].reverse().find((event) => event.type !== 'session.stopped' && event.message !== undefined)
                ?.message ?? 'waiting'
        );
    }

    protected get nativeSidecarStatus(): string {
        return (
            [...this.events].reverse().find((event) => event.nativeSidecarStatus !== undefined)?.nativeSidecarStatus ??
            'unknown'
        );
    }

    protected get selectedModelProviderSelection(): ModelProviderSelection | undefined {
        return [...this.events].reverse().find((event) => event.modelProviderSelection !== undefined)
            ?.modelProviderSelection;
    }

    protected get selectedProvider(): string {
        return this.selectedModelProviderSelection?.providerID ?? 'unknown';
    }

    protected get selectedModel(): string {
        return this.selectedModelProviderSelection?.modelID ?? 'unknown';
    }

    protected get selectedVariant(): string | undefined {
        return this.selectedModelProviderSelection?.variantID;
    }

    protected get selectedSelection(): string {
        const selection = this.selectedModelProviderSelection;
        if (selection === undefined) {
            return 'unknown';
        }
        return formatSelection(selection);
    }

    protected get currentNodeMode(): string {
        return [...this.events].reverse().find((event) => event.abg?.nodeKind !== undefined)?.abg?.nodeKind ?? 'none';
    }
}

export class PlainRenderer extends BufferedRenderer {
    getOutput(): string {
        const lines = [
            'mission-control',
            'command: mctrl',
            `session: ${this.sessionId}`,
            `provider: ${this.selectedProvider}`,
            `model: ${this.selectedModel}`,
            ...(this.selectedVariant === undefined ? [] : [`variant: ${this.selectedVariant}`]),
            `selection: ${this.selectedSelection}`,
            `node mode: ${this.currentNodeMode}`,
            ...this.events.map((event) => {
                const message = eventMessageSuffix(event);
                const graph = event.abg?.graphId !== undefined ? ` graph=${event.abg.graphId}` : '';
                const node = event.abg?.nodeId !== undefined ? ` node=${event.abg.nodeId}` : '';
                const mode = event.abg?.nodeKind !== undefined ? ` mode=${event.abg.nodeKind}` : '';
                const model = event.abg?.model !== undefined ? ` model=${formatSelection(event.abg.model)}` : '';
                return `${event.type}${graph}${node}${mode}${model}${message}`;
            }),
        ];
        return `${lines.join('\n')}\n`;
    }
}

export class InkRenderer extends BufferedRenderer {
    getOutput(): string {
        return `${[
            'mission-control',
            'command: mctrl',
            `session: ${this.sessionId}`,
            `provider: ${this.selectedProvider}`,
            `model: ${this.selectedModel}`,
            ...(this.selectedVariant === undefined ? [] : [`variant: ${this.selectedVariant}`]),
            `selection: ${this.selectedSelection}`,
            `node mode: ${this.currentNodeMode}`,
            'current status: running',
            `event list: ${this.events.map((event) => event.type).join(', ')}`,
            'running task count: 0',
            `last message: ${this.lastMessage}`,
            `native sidecar status: ${this.nativeSidecarStatus}`,
            'Ctrl+C to exit',
        ].join('\n')}\n`;
    }
}

export class JsonRenderer extends BufferedRenderer {
    getOutput(): string {
        const tracker = new JsonMachineStateTracker();
        return `${this.events.map((event) => JSON.stringify(tracker.recordFor(event))).join('\n')}\n`;
    }
}

class JsonMachineStateTracker {
    private sessionId = 'unknown';
    private currentStatus: JsonOutputStatus = 'idle';
    private runState: JsonMachineRunState | undefined;
    private toolState: JsonMachineToolState | undefined;
    private approvalState: JsonMachineApprovalState | undefined;
    private blockedApprovalState: JsonMachineApprovalState | undefined;
    private readonly toolNames = new Map<string, string>();

    recordFor(event: AgentEvent): JsonOutputRecord {
        this.observe(event);
        const approvalId = this.approvalState?.approvalId;
        const toolCallId = this.runState?.toolCallId ?? this.toolState?.toolCallId ?? this.approvalState?.toolCallId;
        return {
            ...event,
            status: this.currentStatus,
            ...(this.runState?.runId !== undefined ? { runId: this.runState.runId } : {}),
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            ...(approvalId !== undefined ? { approvalId } : {}),
            machine: {
                session: {
                    sessionId: this.sessionId,
                    stopped: event.type === 'session.stopped',
                },
                ...(this.runState !== undefined ? { run: this.runState } : {}),
                ...(this.toolState !== undefined ? { tool: this.toolState } : {}),
                ...(this.approvalState !== undefined ? { approval: this.approvalState } : {}),
            },
        };
    }

    private observe(event: AgentEvent): void {
        if (event.sessionId !== undefined) {
            this.sessionId = event.sessionId;
        }
        const providerChunk = event.providerStreamChunk;
        if (providerChunk?.kind === 'tool_call_completed') {
            this.toolNames.set(providerChunk.toolCall.toolCallId, providerChunk.toolCall.toolName);
            this.toolState = {
                toolCallId: providerChunk.toolCall.toolCallId,
                toolName: providerChunk.toolCall.toolName,
                status: 'pending',
            };
        }
        if (event.toolResult !== undefined) {
            const toolName = this.toolNames.get(event.toolResult.toolCallId);
            this.toolState = {
                toolCallId: event.toolResult.toolCallId,
                ...(toolName !== undefined ? { toolName } : {}),
                status: event.toolResult.status === 'completed' ? 'completed' : 'failed',
            };
        }
        if (event.approvalRecord !== undefined) {
            const toolCallId = toolCallIdFromApproval(event);
            const approvalState: JsonMachineApprovalState = {
                approvalId: event.approvalRecord.approvalId,
                state: event.approvalRecord.state,
                ...(toolCallId !== undefined ? { toolCallId } : {}),
                resumable: event.approvalRecord.state === 'pending',
            };
            if (approvalState.state === 'pending') {
                this.blockedApprovalState = approvalState;
                this.approvalState = approvalState;
                return;
            }
            if (this.currentStatus === 'blocked_on_approval' && this.blockedApprovalState !== undefined) {
                this.approvalState = this.blockedApprovalState;
                return;
            }
            this.approvalState = approvalState;
        }
        if (event.run?.state !== undefined) {
            this.currentStatus = event.run.state;
            this.runState = {
                ...(event.run.runId !== undefined ? { runId: event.run.runId } : {}),
                status: event.run.state,
                ...(event.run.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
            };
            if (event.run.state === 'blocked_on_approval' && this.blockedApprovalState !== undefined) {
                this.approvalState = this.blockedApprovalState;
            }
            if (event.run.state !== 'blocked_on_approval') {
                this.blockedApprovalState = undefined;
            }
        }
    }
}

function eventMessageSuffix(event: AgentEvent): string {
    if (event.message === undefined || event.message.startsWith(`${event.type}: `)) {
        return '';
    }
    return ` ${event.message}`;
}

function formatSelection(selection: ModelProviderSelection): string {
    return `${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`;
}

function toolCallIdFromApproval(event: AgentEvent): string | undefined {
    const requestId = event.approvalRecord?.requestId;
    if (requestId?.startsWith('permission_') === true) {
        return requestId.slice('permission_'.length);
    }
    if (event.approvalRecord?.subject.kind !== 'tool') {
        return undefined;
    }
    return event.approvalRecord.subject.id;
}

export type { AgentUIRenderer };
