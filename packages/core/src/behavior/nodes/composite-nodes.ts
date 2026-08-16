import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import {
    cancel,
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
} from './composite-node-utils';
import { runParallelFanOut } from './parallel-fan-out';
import { collectStaticParallelOutcomes } from './parallel-static';
import { runAllApproveVerdict } from './parallel-verdict';
import { createRaceNodeRunner } from './race-node';
import { runSpeculativeNode } from './speculative-node';

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
        ['race', createRaceNodeRunner(runChild)],
        ['join', runJoinNode],
        ['watch', runWatchNode],
        ['statechart', runStatechartNode],
        ['speculative', runSpeculativeNode],
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
            if (signal.type === 'success' && isValidSelectorResult(signal.result)) {
                selected = true;
            }
            yield signal;
        }
        if (selected) {
            yield success(node, context, { selectedChild: childId });
            return;
        }
    }
    yield success(node, context, { selection: 'none', reason: 'no child matched' });
}

async function* runParallelNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    yield started(node, context);
    const fanOutKey = readStringConfig(node, 'fanOutKey');
    if (fanOutKey !== undefined) {
        yield* runParallelFanOut(node, context, fanOutKey, runChild);
        return;
    }
    const { outcomes, aborted } = await collectStaticParallelOutcomes(node, context, runChild);
    const completedChildren: string[] = [];
    const failedChildren: string[] = [];
    for (const outcome of outcomes) {
        for (const signal of outcome.signals) {
            yield signal;
        }
        if (outcome.succeeded) {
            completedChildren.push(outcome.childId);
        }
        if (outcome.failed) {
            failedChildren.push(outcome.childId);
        }
    }
    const completionKey = readStringConfig(node, 'completionKey');
    if (aborted) {
        // Mirror the fanOutKey branch's abort contract (`parallel_fanout_aborted`):
        // children the abort skipped mean the node did NOT complete. Never report
        // success — and never set the completion key — for a partially-run static
        // parallel node, or a checkpoint/resume consumer would treat the skipped
        // children as done.
        yield failure(node, context, {
            code: 'parallel_static_aborted',
            completedChildren,
            failedChildren,
            ...(completionKey !== undefined ? { completionKey } : {}),
        });
        return;
    }
    if (readStringConfig(node, 'completion') === 'any-success') {
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
    if (completionKey !== undefined && context.blackboard !== undefined) {
        context.blackboard.set(completionKey, true);
        yield createAbgEmitSignal({
            graphId: context.graphId,
            nodeId: node.id,
            source: 'parallel',
            eventType: 'blackboard.set',
            timestamp: context.now(),
            payload: { key: completionKey, value: true },
        });
    }
    const verdict = runAllApproveVerdict(node, context);
    if (verdict !== undefined) {
        const verdictWrites = [
            ...(verdict.verdictKey !== undefined ? [{ key: verdict.verdictKey, value: verdict.value }] : []),
            ...(verdict.aggregateKey !== undefined ? [{ key: verdict.aggregateKey, value: verdict.values }] : []),
        ];
        if (context.blackboard !== undefined) {
            for (const write of verdictWrites) {
                context.blackboard.set(write.key, write.value);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    source: 'parallel',
                    eventType: 'blackboard.set',
                    timestamp: context.now(),
                    payload: write,
                });
            }
        }
        yield success(node, context, {
            completedChildren,
            verdict: verdict.value,
            verdicts: verdict.values,
            verdictStrategy: 'all-approve',
            verdictSources: verdict.sources,
            ...(verdict.aggregateKey !== undefined ? { aggregateKey: verdict.aggregateKey } : {}),
        });
        return;
    }
    yield success(node, context, { completedChildren });
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

function isValidSelectorResult(result: unknown): boolean {
    if (typeof result !== 'object' || result === null) {
        return true;
    }
    if ('passed' in result && result.passed === false) {
        return false;
    }
    if ('valid' in result && result.valid === false) {
        return false;
    }
    return true;
}
