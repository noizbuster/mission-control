import {
    type AgentRuntime,
    createObservabilityRedactor,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type {
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { darkTheme, noColorTheme } from '@mission-control/tui/markdown-theme';
import { joinBlocks, renderBlock } from './block-renderer';
import { createBlockAccumulator } from './output-blocks';
import type { AgentUIRenderer } from './ui-adapter';
import { JsonMachineStateTracker } from './json-machine-state';

abstract class BufferedRenderer implements AgentUIRenderer {
    protected readonly events: AgentEvent[] = [];
    private readonly observabilityRedactor = createObservabilityRedactor();

    async start(_runtime: AgentRuntime): Promise<void> {}

    render(event: AgentEvent): void {
        this.events.push(this.redactEvent(event));
    }

    async stop(): Promise<void> {}

    abstract getOutput(): string;

    protected redactEvent(event: AgentEvent): AgentEvent {
        return redactAgentEventForObservability(event, this.observabilityRedactor);
    }

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
        const redactedEvent = this.redactEvent(event);
        const tty = process.stdout.isTTY ?? false;
        const width = process.stdout.columns ?? 80;
        const theme = tty ? darkTheme : noColorTheme;
        for (const block of this.accumulator.consume(redactedEvent)) {
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
        const redactedEvent = this.redactEvent(event);
        const tty = process.stdout.isTTY ?? false;
        const width = process.stdout.columns ?? 80;
        const theme = tty ? darkTheme : noColorTheme;
        for (const block of this.accumulator.consume(redactedEvent)) {
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

function formatSelection(selection: ModelProviderSelection): string {
    return `${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`;
}

export type { AgentUIRenderer };
