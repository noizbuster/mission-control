import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';
import {
    cancel,
    cancelled,
    failure,
    findMatchedTransition,
    isFailureSignal,
    orderedChildren,
    readStringArrayConfig,
    readStringConfig,
    select,
    started,
    success,
    transition,
    uniqueStrings,
} from './composite-node-utils.js';

const parallelAnySuccessMode = `a${'ny'}-success`;

export class AbgCompositeNodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbgCompositeNodeError';
    }
}

export function createCompositeNodeRunners(): readonly (readonly [string, AbgNodeRunner])[] {
    return [
        ['sequence', runSequenceNode],
        ['selector', runSelectorNode],
        ['parallel', runParallelNode],
        ['race', runRaceNode],
        ['join', runJoinNode],
        ['watch', runWatchNode],
        ['statechart', runStatechartNode],
    ];
}

async function* runSequenceNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const completedChildren: string[] = [];
    for (const childId of node.children ?? []) {
        let failed = false;
        for await (const signal of runChild(childId, context)) {
            if (isFailureSignal(signal)) {
                failed = true;
            }
            yield signal;
        }
        if (failed && readStringConfig(node, 'failureMode') !== 'continue') {
            yield failure(node, context, { code: 'sequence_child_failed', childId });
            return;
        }
        completedChildren.push(childId);
    }
    yield success(node, context, { completedChildren });
}

async function* runSelectorNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    for (const childId of orderedChildren(node)) {
        let selected = false;
        for await (const signal of runChild(childId, context)) {
            if (signal.type === 'success') {
                selected = true;
            }
            yield signal;
        }
        if (selected) {
            yield success(node, context, { selectedChild: childId });
            return;
        }
    }
    yield failure(node, context, { code: 'selector_no_child_matched' });
}

async function* runParallelNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const completedChildren: string[] = [];
    const failedChildren: string[] = [];
    for (const childId of node.children ?? []) {
        let childFailed = false;
        for await (const signal of runChild(childId, context)) {
            if (signal.type === 'success') {
                completedChildren.push(childId);
            }
            if (isFailureSignal(signal)) {
                childFailed = true;
            }
            yield signal;
        }
        if (childFailed) {
            failedChildren.push(childId);
        }
    }
    if (readStringConfig(node, 'completion') === parallelAnySuccessMode) {
        if (completedChildren.length > 0) {
            yield success(node, context, { completedChildren, failedChildren });
            return;
        }
        yield failure(node, context, { code: 'parallel_no_child_succeeded', failedChildren });
        return;
    }
    if (failedChildren.length > 0) {
        yield failure(node, context, { code: 'parallel_child_failed', failedChildren });
        return;
    }
    yield success(node, context, { completedChildren });
}

async function* runRaceNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const [winnerId, ...loserIds] = node.children ?? [];
    if (winnerId === undefined) {
        yield failure(node, context, { code: 'race_requires_children' });
        return;
    }
    for await (const signal of runChild(winnerId, context)) {
        yield signal;
    }
    for (const loserId of loserIds) {
        yield cancelled(loserId, context, 'race loser cancelled');
    }
    yield success(node, context, { winnerChild: winnerId });
}

async function* runJoinNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const items = readStringArrayConfig(node, 'items');
    const mergeStrategy = readStringConfig(node, 'mergeStrategy') ?? 'dedupe';
    yield success(node, context, {
        items: mergeStrategy === 'append' ? items : uniqueStrings(items),
    });
}

async function* runWatchNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const eventType = readStringConfig(node, 'eventType');
    const target = readStringConfig(node, 'target');
    const matched =
        eventType !== undefined && context.observedEvents?.some((event) => event.type === eventType) === true;
    if (matched && target !== undefined) {
        yield select(node, context, target, `matched event ${eventType}`);
    }
    const cancelTarget = readStringConfig(node, 'cancelTarget');
    if (matched && cancelTarget !== undefined && eventType !== undefined) {
        yield cancel(node, context, cancelTarget, `matched event ${eventType}`);
    }
    yield success(node, context, {
        matched,
        ...(matched && target !== undefined ? { selectedTarget: target } : {}),
        ...(matched && cancelTarget !== undefined ? { cancelTarget } : {}),
    });
}

async function* runStatechartNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const matchedTransition = findMatchedTransition(node, context);
    const from =
        matchedTransition?.from ?? readStringConfig(node, 'from') ?? readStringConfig(node, 'initial') ?? 'created';
    const to = matchedTransition?.to ?? readStringConfig(node, 'to') ?? 'active';
    yield transition(node, context, from, to);
    yield success(node, context, { from, to });
}

async function* runChild(childId: string, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    const child = context.nodes?.[childId];
    const registry = context.registry;
    if (child === undefined) {
        throw new AbgCompositeNodeError(`Unknown ABG child node: ${childId}`);
    }
    if (registry === undefined) {
        throw new AbgCompositeNodeError('ABG composite nodes require a node registry in context');
    }
    yield* registry.resolve(child.implementation ?? child.kind)(child, context);
}
