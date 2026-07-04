import type { AgentRuntime } from '@mission-control/core';
import type {
    AgentEvent,
    ApprovalLifecycleState,
    ModelProviderSelection,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { darkTheme, noColorTheme } from '../components/markdown/theme.js';
import { joinBlocks, renderBlock } from './block-renderer.js';
import { createBlockAccumulator } from './output-blocks.js';
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

export type BlockRendererOptions = { readonly thinking?: boolean };

export class PlainRenderer extends BufferedRenderer {
    readonly streamedOutput = true;
    private readonly thinking: boolean;
    private readonly accumulator = createBlockAccumulator();
    private readonly rendered: string[] = [];

    constructor(options: BlockRendererOptions = {}) {
        super();
        this.thinking = options.thinking ?? false;
    }

    render(event: AgentEvent): void {
        const tty = process.stdout.isTTY ?? false;
        const width = process.stdout.columns ?? 80;
        const theme = tty ? darkTheme : noColorTheme;
        for (const block of this.accumulator.consume(event)) {
            const rendered = renderBlock(block, { width, tty, thinking: this.thinking, theme });
            process.stdout.write(rendered);
            this.rendered.push(rendered);
        }
    }

    getOutput(): string {
        return joinBlocks(this.rendered);
    }
}

export class TuiRenderer extends BufferedRenderer {
    readonly streamedOutput = true;
    private readonly thinking: boolean;
    private readonly accumulator = createBlockAccumulator();
    private readonly rendered: string[] = [];

    constructor(options: BlockRendererOptions = {}) {
        super();
        this.thinking = options.thinking ?? false;
    }

    render(event: AgentEvent): void {
        const tty = process.stdout.isTTY ?? false;
        const width = process.stdout.columns ?? 80;
        const theme = tty ? darkTheme : noColorTheme;
        for (const block of this.accumulator.consume(event)) {
            const rendered = renderBlock(block, { width, tty, thinking: this.thinking, theme });
            process.stdout.write(rendered);
            this.rendered.push(rendered);
        }
    }

    getOutput(): string {
        return joinBlocks(this.rendered);
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
