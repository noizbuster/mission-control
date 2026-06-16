/**
 * ABG Memory node — interacts with the Blackboard (ABG §10.4).
 *
 * This is the REAL leaf node that replaces the mock `runMemoryNode` in leaf-nodes.ts.
 * It supports key/value operations (get, set, has, delete) and message operations
 * (messages.get, messages.append) through the Blackboard.
 *
 * All operations emit their corresponding event type and return success with the
 * operation result, or failure with a specific error code when the Blackboard is
 * unavailable or the operation/parameters are invalid.
 */

import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

function protocolError(code: string, message: string): { code: string; message: string } {
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
        source: 'memory',
        eventType,
        timestamp: context.now(),
        payload,
    });
}

export const runMemoryNode: AbgNodeRunner = async function* (
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    yield started(node, context);

    if (context.blackboard === undefined) {
        yield failure(node.id, context.graphId, {
            code: 'memory_unavailable',
            message: 'Blackboard not available in context',
        });
        return;
    }

    const op = node.config?.['op'];
    const key = node.config?.['key'];
    const value = node.config?.['value'];

    if (op === 'get') {
        if (typeof key !== 'string') {
            yield emit(
                node,
                context,
                'memory.read',
                protocolError('memory_op_invalid', 'Operation "get" requires a string key'),
            );
            yield failure(node.id, context.graphId, {
                code: 'memory_op_invalid',
                message: 'Operation "get" requires a string key',
            });
            return;
        }
        const result = context.blackboard.get(key);
        yield emit(node, context, 'memory.read', { key, value: result });
        yield success(node.id, context.graphId, { key, value: result });
        return;
    }

    if (op === 'set') {
        if (typeof key !== 'string') {
            yield emit(
                node,
                context,
                'memory.written',
                protocolError('memory_op_invalid', 'Operation "set" requires a string key'),
            );
            yield failure(node.id, context.graphId, {
                code: 'memory_op_invalid',
                message: 'Operation "set" requires a string key',
            });
            return;
        }
        context.blackboard.set(key, value);
        yield emit(node, context, 'memory.written', { key, value });
        yield success(node.id, context.graphId, { key });
        return;
    }

    if (op === 'has') {
        if (typeof key !== 'string') {
            yield failure(node.id, context.graphId, {
                code: 'memory_op_invalid',
                message: 'Operation "has" requires a string key',
            });
            return;
        }
        const present = context.blackboard.has(key);
        yield emit(node, context, 'memory.checked', { key, present });
        yield success(node.id, context.graphId, { key, present });
        return;
    }

    if (op === 'delete') {
        if (typeof key !== 'string') {
            yield failure(node.id, context.graphId, {
                code: 'memory_op_invalid',
                message: 'Operation "delete" requires a string key',
            });
            return;
        }
        context.blackboard.delete(key);
        yield emit(node, context, 'memory.deleted', { key });
        yield success(node.id, context.graphId, { key });
        return;
    }

    if (op === 'messages.get') {
        const messages = context.blackboard.getMessages();
        yield emit(node, context, 'memory.read', { messages: messages.length });
        yield success(node.id, context.graphId, { messages });
        return;
    }

    if (op === 'messages.append') {
        if (!Array.isArray(value)) {
            yield failure(node.id, context.graphId, {
                code: 'memory_op_invalid',
                message: 'Operation "messages.append" requires an array value',
            });
            return;
        }
        const msgs = value as readonly ModelMessage[];
        context.blackboard.appendMessages(msgs);
        yield emit(node, context, 'memory.written', { appended: msgs.length });
        yield success(node.id, context.graphId, { appended: msgs.length });
        return;
    }

    yield failure(node.id, context.graphId, {
        code: 'memory_op_invalid',
        message: op === undefined ? 'Operation is required' : `Unknown operation: ${String(op)}`,
    });
};
