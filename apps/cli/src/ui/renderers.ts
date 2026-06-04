import type { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { AgentUIRenderer } from './ui-adapter.js';

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
        return [...this.events].reverse().find((event) => event.message !== undefined)?.message ?? 'waiting';
    }

    protected get nativeSidecarStatus(): string {
        return (
            [...this.events].reverse().find((event) => event.nativeSidecarStatus !== undefined)?.nativeSidecarStatus ??
            'unknown'
        );
    }

    protected get selectedModel(): string {
        const selection = [...this.events]
            .reverse()
            .find((event) => event.modelProviderSelection !== undefined)?.modelProviderSelection;
        if (selection === undefined) {
            return 'unknown';
        }
        return `${selection.providerID}/${selection.modelID}`;
    }
}

export class PlainRenderer extends BufferedRenderer {
    getOutput(): string {
        const lines = [
            'mission-control',
            'command: mctrl',
            `session: ${this.sessionId}`,
            `model: ${this.selectedModel}`,
            ...this.events.map((event) => {
                const message = event.message ? ` ${event.message}` : '';
                const graph = event.abg?.graphId !== undefined ? ` graph=${event.abg.graphId}` : '';
                const node = event.abg?.nodeId !== undefined ? ` node=${event.abg.nodeId}` : '';
                const model =
                    event.abg?.model !== undefined
                        ? ` model=${event.abg.model.providerID}/${event.abg.model.modelID}`
                        : '';
                return `${event.type}${graph}${node}${model}${message}`;
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
            `model: ${this.selectedModel}`,
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
        return `${this.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    }
}

export type { AgentUIRenderer };
