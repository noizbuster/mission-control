import type { TextStreamPart, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { createAbgToolSettlementLedger } from './abg-tool-bridge';
import { abgSignalsFromStreamPart, type StreamPartAdapterContext } from './ai-sdk-adapter';
import { eventTypes, NOW } from './llm-actor-node-test-support';

describe('ai-sdk-adapter', () => {
    const ctx: StreamPartAdapterContext = { graphId: 'g1', nodeId: 'llm-1', now: () => NOW };

    it('maps stream parts to ABG events', () => {
        const textOut = abgSignalsFromStreamPart(
            { type: 'text-delta', id: 't', text: 'hi' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(textOut)).toEqual(['llm.text.delta']);

        const toolCallOut = abgSignalsFromStreamPart(
            { type: 'tool-call', toolCallId: 'c', toolName: 'echo', input: '{}' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolCallOut)).toEqual(['llm.tool_call.proposed']);

        const toolResultOut = abgSignalsFromStreamPart(
            { type: 'tool-result', toolCallId: 'c', toolName: 'echo', output: 'ok' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolResultOut)).toEqual(['tool.completed']);
    });

    it('maps tool-error and tool-output-denied to ABG events (review fix #3)', () => {
        const toolErrorOut = abgSignalsFromStreamPart(
            { type: 'tool-error', toolCallId: 'c', toolName: 'echo' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolErrorOut)).toEqual(['tool.failed']);

        const deniedOut = abgSignalsFromStreamPart(
            { type: 'tool-output-denied', toolCallId: 'c', toolName: 'echo' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(deniedOut)).toEqual(['tool.denied']);
    });

    it('redacts credentials from SDK error parts before emitting llm.error', () => {
        const secret = ['sk', 'sdk_error_part_123'].join('-');
        const out = abgSignalsFromStreamPart(
            { type: 'error', error: new Error(`provider exploded ${secret}`) } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(out)).toEqual(['llm.error']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: string }).error).toBe('provider exploded [REDACTED_CREDENTIAL]');
        expect(JSON.stringify(event)).not.toContain(secret);
    });

    it('recovers a failed settlement from the ledger so tool-result maps to tool.failed (not completed)', () => {
        const ledger = createAbgToolSettlementLedger();
        ledger.record({
            toolCallId: 'c',
            toolName: 'echo',
            status: 'failed',
            error: { code: 'tool_failed', message: 'echo blew up', retryable: false },
        });
        const out = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'Tool "echo" failed (tool_failed): echo blew up',
            } as TextStreamPart<ToolSet>,
            { ...ctx, settlementLedger: ledger },
        );
        expect(eventTypes(out)).toEqual(['tool.failed']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: { code: string } }).error.code).toBe('tool_failed');
    });

    it('carries the settlement output on tool.completed and falls back to part.output without a ledger', () => {
        const ledger = createAbgToolSettlementLedger();
        ledger.record({ toolCallId: 'c', toolName: 'echo', status: 'completed', output: 'echoed: hi' });
        const withLedger = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'model-facing string',
            } as TextStreamPart<ToolSet>,
            { ...ctx, settlementLedger: ledger },
        );
        expect(eventTypes(withLedger)).toEqual(['tool.completed']);
        const ledgerEvent = withLedger[0];
        if (ledgerEvent?.type !== 'emit') throw new Error('expected emit');
        expect((ledgerEvent.event.payload as { output: unknown }).output).toBe('echoed: hi');

        const withoutLedger = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'fallback output',
            } as TextStreamPart<ToolSet>,
            ctx,
        );
        const fallbackEvent = withoutLedger[0];
        if (fallbackEvent?.type !== 'emit') throw new Error('expected emit');
        expect((fallbackEvent.event.payload as { output: unknown }).output).toBe('fallback output');
    });

    it('coerces a tool-error part into a tool.failed ProtocolError', () => {
        const out = abgSignalsFromStreamPart(
            {
                type: 'tool-error',
                toolCallId: 'c',
                toolName: 'echo',
                error: new Error('execute threw'),
            } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(out)).toEqual(['tool.failed']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: { code: string; message: string } }).error).toEqual({
            code: 'unknown',
            message: 'execute threw',
            retryable: false,
        });
    });
});
