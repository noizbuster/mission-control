import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { createCodingAgentNodeRegistry } from '../coding-agent-registry.js';
import { runAbgGraph } from '../graph-runner.js';

describe('ToolActor invocation identity', () => {
    it('keeps each repeated node invocation unique and correlated across request and result events', async () => {
        // Given
        const invokedCallIds: string[] = [];
        let callSequence = 0;
        const toolRegistry = new ToolRegistry();
        toolRegistry.register({
            name: 'echo',
            description: 'Echo a value.',
            capabilityClasses: ['read'],
            parametersJsonSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
            },
            inputSchema: z.object({ text: z.string() }),
            outputSchema: z.object({ text: z.string() }),
            outputLimit: { maxModelOutputChars: 2000 },
            execute: (input, context) => {
                invokedCallIds.push(context.toolCallId);
                return input;
            },
        });

        // When
        const result = await runAbgGraph({
            graph: {
                id: 'repeated-tool-node',
                version: '0.1.0',
                entryNodeId: 'repeat',
                defaults: {
                    model: { providerID: 'local', modelID: 'local-echo' },
                    maxNodeRuns: 2,
                    retryLimit: 0,
                },
                nodes: [
                    {
                        id: 'repeat',
                        kind: 'tool',
                        config: { tool: 'echo', arguments: { text: 'same node' } },
                    },
                ],
                edges: [{ source: 'repeat', target: 'repeat' }],
                rules: [],
                policies: [],
            },
            sessionId: 'session_repeated_tool_node',
            now: () => '2026-07-13T00:00:00.000Z',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            registry: createCodingAgentNodeRegistry(),
            toolRegistry,
            createToolCallId: () => {
                callSequence += 1;
                return `generated-tool-call-${callSequence}`;
            },
        });

        // Then
        const started = result.events.filter(
            (event) => event.type === 'tool.started' && event.abg?.nodeId === 'repeat',
        );
        const completed = result.events.filter(
            (event) => event.type === 'tool.completed' && event.abg?.nodeId === 'repeat',
        );
        expect(invokedCallIds).toHaveLength(2);
        expect(invokedCallIds).toEqual(['generated-tool-call-1', 'generated-tool-call-2']);
        expect(new Set(invokedCallIds).size).toBe(2);
        expect(started.map((event) => event.taskId)).toEqual(
            invokedCallIds.flatMap((toolCallId) => [toolCallId, toolCallId]),
        );
        expect(completed.map((event) => event.taskId)).toEqual(
            invokedCallIds.flatMap((toolCallId) => [toolCallId, toolCallId]),
        );
        expect(completed.flatMap((event) => event.toolResult?.toolCallId ?? [])).toEqual(invokedCallIds);
    });
});
