import type { AgentEvent } from '@mission-control/protocol';

export type RunCoordinatorIdFactory = (prefix: string, index: number) => string;

type RunCoordinatorIdEventStore = {
    readonly getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
};

export class RunCoordinatorIdSequence {
    private readonly sessionId: string;
    private readonly store: RunCoordinatorIdEventStore;
    private readonly createId: RunCoordinatorIdFactory;
    private seed: Promise<void> | undefined;
    private nextIndex = 0;

    constructor(options: {
        readonly sessionId: string;
        readonly store: RunCoordinatorIdEventStore;
        readonly createId: RunCoordinatorIdFactory;
    }) {
        this.sessionId = options.sessionId;
        this.store = options.store;
        this.createId = options.createId;
    }

    async next(prefix: string): Promise<string> {
        await this.ensureSeeded();
        this.nextIndex += 1;
        return this.createId(prefix, this.nextIndex);
    }

    async observe(...ids: readonly (string | undefined)[]): Promise<void> {
        await this.ensureSeeded();
        this.nextIndex = Math.max(this.nextIndex, maxNumericSuffix(ids));
    }

    private async ensureSeeded(): Promise<void> {
        this.seed ??= this.seedFromStore();
        await this.seed;
    }

    private async seedFromStore(): Promise<void> {
        this.nextIndex = maxRunCoordinatorIdIndex(await this.store.getEvents(this.sessionId), this.sessionId);
    }
}

export function maxRunCoordinatorIdIndex(events: readonly AgentEvent[], sessionId: string): number {
    let maxIndex = 0;
    for (const event of events) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        maxIndex = Math.max(maxIndex, maxNumericSuffix(idsFromEvent(event)));
    }
    return maxIndex;
}

function idsFromEvent(event: AgentEvent): readonly string[] {
    const ids: string[] = [];
    addOptional(ids, event.run?.runId);
    addOptional(ids, event.run?.inputId);
    addOptional(ids, event.run?.messageId);
    addOptional(ids, event.run?.providerTurnId);
    addOptional(ids, event.run?.toolCallId);
    addOptional(ids, event.run?.graphId);
    addOptional(ids, event.run?.nodeId);
    addOptional(ids, event.transcript?.inputId);
    addOptional(ids, event.transcript?.messageId);
    addOptional(ids, event.transcript?.providerTurnId);
    addOptional(ids, event.transcript?.toolCallId);
    addOptional(ids, event.transcript?.graphId);
    addOptional(ids, event.transcript?.nodeId);
    addProviderChunkIds(ids, event.providerStreamChunk);
    return ids;
}

function addProviderChunkIds(ids: string[], chunk: AgentEvent['providerStreamChunk']): void {
    if (chunk === undefined) {
        return;
    }
    ids.push(chunk.requestId);
    switch (chunk.kind) {
        case 'response_completed':
            ids.push(chunk.message.messageId, ...(chunk.message.toolCallIds ?? []));
            return;
        case 'tool_call_delta':
            ids.push(chunk.toolCallId);
            return;
        case 'tool_call_completed':
            ids.push(chunk.toolCall.toolCallId);
            return;
        case 'response_started':
        case 'text_delta':
        case 'response_failed':
            return;
    }
}

function addOptional(ids: string[], value: string | undefined): void {
    if (value !== undefined) {
        ids.push(value);
    }
}

function maxNumericSuffix(ids: readonly (string | undefined)[]): number {
    let maxIndex = 0;
    for (const id of ids) {
        const index = numericSuffix(id);
        if (index !== undefined) {
            maxIndex = Math.max(maxIndex, index);
        }
    }
    return maxIndex;
}

function numericSuffix(id: string | undefined): number | undefined {
    const match = id?.match(/_(\d+)$/u);
    if (match?.[1] === undefined) {
        return undefined;
    }
    return Number.parseInt(match[1], 10);
}
