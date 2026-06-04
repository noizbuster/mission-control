import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { AbgNodeRunContext } from '../node-registry.js';

export function started(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return {
        type: 'started',
        graphId: context.graphId,
        nodeId: node.id,
    };
}

export function success(node: AbgNodeSpec, context: AbgNodeRunContext, result?: unknown): AbgSignal {
    return {
        type: 'success',
        graphId: context.graphId,
        nodeId: node.id,
        ...(result !== undefined ? { result } : {}),
    };
}

export function failure(node: AbgNodeSpec, context: AbgNodeRunContext, error: unknown): AbgSignal {
    return {
        type: 'failure',
        graphId: context.graphId,
        nodeId: node.id,
        error,
    };
}

export function cancelled(nodeId: string, context: AbgNodeRunContext, reason: string): AbgSignal {
    return {
        type: 'cancelled',
        graphId: context.graphId,
        nodeId,
        reason,
    };
}

export function select(node: AbgNodeSpec, context: AbgNodeRunContext, target: string, reason: string): AbgSignal {
    return {
        type: 'select',
        graphId: context.graphId,
        nodeId: node.id,
        target,
        reason,
    };
}

export function cancel(node: AbgNodeSpec, context: AbgNodeRunContext, target: string, reason: string): AbgSignal {
    return {
        type: 'cancel',
        graphId: context.graphId,
        nodeId: node.id,
        target,
        reason,
    };
}

export function transition(node: AbgNodeSpec, context: AbgNodeRunContext, from: string, to: string): AbgSignal {
    return {
        type: 'transition',
        graphId: context.graphId,
        nodeId: node.id,
        from,
        to,
    };
}

export function orderedChildren(node: AbgNodeSpec): readonly string[] {
    const children = node.children ?? [];
    const priorities = readStringArrayConfig(node, 'priorities');
    if (priorities.length === 0) {
        return children;
    }
    const priorityByChild = new Map(priorities.map((childId, index) => [childId, index]));
    return [...children].sort((left, right) => {
        const leftPriority = priorityByChild.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = priorityByChild.get(right) ?? Number.MAX_SAFE_INTEGER;
        return leftPriority - rightPriority;
    });
}

export function readStringConfig(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readStringArrayConfig(node: AbgNodeSpec, key: string): readonly string[] {
    const value = node.config?.[key];
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === 'string' && item.length > 0);
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}

export function findMatchedTransition(node: AbgNodeSpec, context: AbgNodeRunContext): StatechartTransition | undefined {
    return readTransitionConfig(node).find(
        (transitionConfig) =>
            context.observedEvents?.some((event) => event.type === transitionConfig.eventType) === true,
    );
}

export function isFailureSignal(signal: AbgSignal): boolean {
    return signal.type === 'failure' || signal.type === 'cancelled';
}

type StatechartTransition = {
    readonly eventType: string;
    readonly from: string;
    readonly to: string;
};

function readTransitionConfig(node: AbgNodeSpec): readonly StatechartTransition[] {
    const value = node.config?.['transitions'];
    if (!Array.isArray(value)) {
        return [];
    }
    const transitions: StatechartTransition[] = [];
    for (const item of value) {
        const transitionConfig = readTransition(item);
        if (transitionConfig !== undefined) {
            transitions.push(transitionConfig);
        }
    }
    return transitions;
}

function readTransition(value: unknown): StatechartTransition | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const eventType = readRecordString(value, 'eventType');
    const from = readRecordString(value, 'from');
    const to = readRecordString(value, 'to');
    if (eventType === undefined || from === undefined || to === undefined) {
        return undefined;
    }
    return { eventType, from, to };
}

function readRecordString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}
