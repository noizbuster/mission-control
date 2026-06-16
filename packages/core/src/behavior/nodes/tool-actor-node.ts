/**
 * ABG ToolActor node — invokes tools through the ToolRegistry (ABG §10.6).
 *
 * This is the REAL leaf node that replaces the mock `runToolNode` in leaf-nodes.ts.
 * It:
 * - Validates that a tool name is provided in config
 * - Resolves the tool advertisement from the ToolRegistry
 * - Invokes the tool with arguments (JSON-serialized)
 * - Emits `tool.started` → `tool.completed` or `tool.failed`
 * - Returns success with the tool output or failure with the error code
 *
 * All errors are surfaced as ProtocolError-shaped failures with specific codes
 * (`tool_registry_unavailable`, `tool_name_required`, `tool_unknown`, `tool_failed`).
 */

import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ToolInvocationInput } from '../../tools/tool-registry.js';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

function nodeError(code: string, message: string): { code: string; message: string } {
    return { code, message };
}

function started(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };
}

function success(nodeId: string, graphId: string, result?: unknown): AbgSignal {
    return {
        type: 'success',
        nodeId,
        graphId,
        ...(result !== undefined ? { result } : {}),
    };
}

function failure(nodeId: string, graphId: string, error: unknown): AbgSignal {
    return {
        type: 'failure',
        nodeId,
        graphId,
        error,
    };
}

function emit(node: AbgNodeSpec, context: AbgNodeRunContext, eventType: string, payload?: unknown): AbgSignal {
    return createAbgEmitSignal({
        graphId: context.graphId,
        nodeId: node.id,
        source: 'tool-actor',
        eventType,
        timestamp: context.now(),
        payload,
    });
}

export const runToolActorNode: AbgNodeRunner = async function* (
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    yield started(node, context);

    if (context.toolRegistry === undefined) {
        yield emit(
            node,
            context,
            'tool.failed',
            nodeError('tool_registry_unavailable', 'ToolRegistry not available in context'),
        );
        yield failure(node.id, context.graphId, {
            code: 'tool_registry_unavailable',
            message: 'ToolRegistry not available in context',
        });
        return;
    }

    const toolName = node.config?.['tool'];
    const toolCallId = node.config?.['toolCallId'] ?? node.id;
    const argumentsValue = node.config?.['arguments'] ?? {};

    if (typeof toolName !== 'string' || toolName.length === 0) {
        yield emit(
            node,
            context,
            'tool.failed',
            nodeError('tool_name_required', 'Tool name must be a non-empty string'),
        );
        yield failure(node.id, context.graphId, {
            code: 'tool_name_required',
            message: 'Tool name must be a non-empty string',
        });
        return;
    }

    const advertisement = context.toolRegistry.advertise().find((a) => a.name === toolName);
    if (advertisement === undefined) {
        const error = nodeError('tool_unknown', `Unknown tool: ${toolName}`);
        yield emit(node, context, 'tool.failed', { ...error, toolName });
        yield failure(node.id, context.graphId, {
            code: error.code,
            toolName,
            message: error.message,
        });
        return;
    }

    yield emit(node, context, 'tool.started', { toolName, toolCallId });

    const invocation: ToolInvocationInput = {
        toolCallId: String(toolCallId),
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(argumentsValue ?? {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
    };

    const settlement = await context.toolRegistry.invoke(invocation);

    if (settlement.result.status === 'completed') {
        const output = settlement.result.output ?? settlement.modelOutput?.content;
        if (output === undefined) {
            // Completed but produced no model-facing output. Surface as a failure so the
            // success/failure contract matches the §5.2 bridge (which returns a 'failed'
            // string for the same case) instead of an indistinguishable success(undefined).
            const noOutput = nodeError('tool_no_output', `Tool "${toolName}" completed with no model output`);
            yield emit(node, context, 'tool.failed', { toolName, toolCallId, error: noOutput });
            yield failure(node.id, context.graphId, { ...noOutput, toolName });
            return;
        }
        yield emit(node, context, 'tool.completed', {
            toolName,
            toolCallId,
        });
        yield success(node.id, context.graphId, {
            toolName,
            output,
        });
        return;
    }

    const error = settlement.result.error;
    yield emit(node, context, 'tool.failed', {
        toolName,
        toolCallId,
        error,
    });
    yield failure(node.id, context.graphId, {
        code: error?.code ?? 'tool_failed',
        toolName,
        message: error?.message,
    });
};
