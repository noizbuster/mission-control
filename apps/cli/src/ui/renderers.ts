import {
    type AgentRuntime,
    createObservabilityRedactor,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { darkTheme, noColorTheme } from '@mission-control/tui/markdown-theme';
import { joinBlocks, renderBlock } from './block-renderer';
import { JsonMachineStateTracker } from './json-machine-state';
import { createBlockAccumulator } from './output-blocks';
import { formatSessionFinalizeLineFromInfo, type SessionFinalizeInfo } from './session-finalize';
import type { AgentUIRenderer } from './ui-adapter';

abstract class BufferedRenderer implements AgentUIRenderer {
    protected readonly events: AgentEvent[] = [];
    private readonly observabilityRedactor = createObservabilityRedactor();
    private finalized: SessionFinalizeInfo | undefined;

    async start(_runtime: AgentRuntime): Promise<void> {}

    render(event: AgentEvent): void {
        this.events.push(this.redactEvent(event));
    }

    async stop(): Promise<void> {}

    abstract getOutput(): string;

    finalize(info: SessionFinalizeInfo): void {
        if (this.finalized !== undefined) {
            return;
        }
        this.finalized = info;
        this.writeFinalize(info);
    }

    protected writeFinalize(info: SessionFinalizeInfo): void {
        process.stdout.write(`${formatSessionFinalizeLineFromInfo(info)}\n`);
    }

    protected get finalizeInfo(): SessionFinalizeInfo | undefined {
        return this.finalized;
    }

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
        const info = this.finalizeInfo;
        if (info !== undefined) {
            return joinBlocks([...this.rendered, `${formatSessionFinalizeLineFromInfo(info)}\n`]);
        }
        return joinBlocks(this.rendered);
    }
}

/**
 * `TuiRenderer` is now `PlainRenderer`: the two were byte-identical (the streamed block
 * pipeline, the `getOutput()` join, the thinking flag), so they collapsed into one class.
 * The name is retained as a reference so existing imports keep working; `createRenderer`
 * maps both the `'plain'` and `'tui'` CLI modes to `PlainRenderer`.
 */
export const TuiRenderer = PlainRenderer;

export class JsonRenderer extends BufferedRenderer {
    getOutput(): string {
        const tracker = new JsonMachineStateTracker();
        return `${this.events.map((event) => JSON.stringify(tracker.recordFor(event))).join('\n')}\n`;
    }

    /**
     * Override the no-op base to a true no-op without stdout writes. The durable
     * `session.finalize` AgentEvent is appended to `events[]` through the normal
     * render path and surfaces as a JSON line in `getOutput()`, so emitting a
     * second plain-text line would corrupt the JSON event stream.
     */
    protected writeFinalize(_info: SessionFinalizeInfo): void {
        // intentionally no-op
    }
}

function formatSelection(selection: ModelProviderSelection): string {
    return `${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`;
}

export type { AgentUIRenderer };
