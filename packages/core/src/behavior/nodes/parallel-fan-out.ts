import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit.js';
import type { AbgNodeRunContext } from '../node-registry.js';
import {
    failure,
    isFailureSignal,
    readBooleanConfig,
    readPositiveIntConfig,
    readStringConfig,
    success,
} from './composite-node-utils.js';

/**
 * Bounded fan-out concurrency for the parallel node's `fanOutKey` branch. Matches
 * the graph node concurrency default (`graph-coordinator-helpers.ts`); the parallel
 * node dispatches children through the registry directly rather than the scheduler,
 * so the bound is enforced locally here, in fixed-size waves.
 */
const DEFAULT_FAN_OUT_CONCURRENCY = 2;

/** Blackboard key that receives the aggregated per-item results array by default. */
const DEFAULT_FAN_OUT_AGGREGATE_KEY = 'delegate.results';

type RunChild = (childId: string, context: AbgNodeRunContext) => AsyncIterable<AbgSignal>;

type FanOutItemResult = {
    readonly item: unknown;
    readonly index: number;
    readonly result?: unknown;
    readonly failed: boolean;
};

type FanOutItemOutcome = {
    readonly index: number;
    readonly signals: readonly AbgSignal[];
    readonly failed: boolean;
    readonly result?: unknown;
};

/**
 * Run a `parallel` node's `fanOutKey` branch: read an array from the blackboard, run
 * the single template child once per item under bounded (wave-based) concurrency,
 * aggregate outputs into `aggregateKey` (default `delegate.results`), and set
 * `completionKey` only after every item has settled. Static `children` parallelism
 * lives in `runParallelNode` and is untouched here.
 *
 * Fail-closed semantics: a missing blackboard, a missing/non-array `fanOutKey` value,
 * or a missing template child emits a `failure` and runs nothing. An empty array
 * succeeds with an empty aggregate and sets the completion key. A failed required
 * item fails the parent unless `config.continueOnFailure` is true.
 */
export async function* runParallelFanOut(
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
    fanOutKey: string,
    runChild: RunChild,
): AsyncIterable<AbgSignal> {
    const aggregateKey = readStringConfig(node, 'aggregateKey') ?? DEFAULT_FAN_OUT_AGGREGATE_KEY;
    const completionKey = readStringConfig(node, 'completionKey');
    const continueOnFailure = readBooleanConfig(node, 'continueOnFailure') === true;
    const concurrency = readPositiveIntConfig(node, 'concurrency') ?? DEFAULT_FAN_OUT_CONCURRENCY;
    const templateChildId = node.children?.[0];

    if (context.blackboard === undefined) {
        yield failure(node, context, { code: 'parallel_fanout_no_blackboard', fanOutKey });
        return;
    }
    const blackboard = context.blackboard;
    const items = blackboard.get(fanOutKey);
    if (!Array.isArray(items)) {
        yield failure(node, context, { code: 'parallel_fanout_key_not_array', fanOutKey });
        return;
    }
    if (templateChildId === undefined) {
        yield failure(node, context, { code: 'parallel_fanout_no_template_child', fanOutKey });
        return;
    }
    if (context.nodes?.[templateChildId] === undefined || context.registry === undefined) {
        yield failure(node, context, {
            code: 'parallel_fanout_template_unresolved',
            fanOutKey,
            templateChild: templateChildId,
        });
        return;
    }

    const setKey = (key: string, value: unknown): AbgSignal => {
        blackboard.set(key, value);
        return createAbgEmitSignal({
            graphId: context.graphId,
            nodeId: node.id,
            source: 'parallel',
            eventType: 'blackboard.set',
            timestamp: context.now(),
            payload: { key, value },
        });
    };

    if (items.length === 0) {
        yield setKey(aggregateKey, []);
        if (completionKey !== undefined) {
            yield setKey(completionKey, true);
        }
        yield success(node, context, { completedChildren: [], aggregateKey, itemCount: 0 });
        return;
    }

    const results: FanOutItemResult[] = new Array(items.length);
    const completedChildren: string[] = [];
    const failedChildren: string[] = [];

    for (let start = 0; start < items.length; start += concurrency) {
        const end = Math.min(start + concurrency, items.length);
        const wave = await Promise.all(
            indices(start, end).map((index) => runFanOutItem(templateChildId, index, items[index], context, runChild)),
        );
        for (const outcome of wave) {
            for (const signal of outcome.signals) {
                yield signal;
            }
            results[outcome.index] = {
                item: items[outcome.index],
                index: outcome.index,
                ...(outcome.result !== undefined ? { result: outcome.result } : {}),
                failed: outcome.failed,
            };
            const childRef = `${templateChildId}:${outcome.index}`;
            if (outcome.failed) {
                failedChildren.push(childRef);
            } else {
                completedChildren.push(childRef);
            }
        }
    }

    if (failedChildren.length > 0 && !continueOnFailure) {
        yield failure(node, context, {
            code: 'parallel_fanout_child_failed',
            failedChildren,
            completedChildren,
            aggregateKey,
        });
        return;
    }

    yield setKey(aggregateKey, results);
    if (completionKey !== undefined) {
        yield setKey(completionKey, true);
    }
    yield success(node, context, {
        completedChildren,
        ...(failedChildren.length > 0 ? { failedChildren } : {}),
        aggregateKey,
        itemCount: items.length,
    });
}

async function runFanOutItem(
    templateChildId: string,
    index: number,
    item: unknown,
    context: AbgNodeRunContext,
    runChild: RunChild,
): Promise<FanOutItemOutcome> {
    const signals: AbgSignal[] = [];
    const itemContext: AbgNodeRunContext = {
        ...context,
        input: { ...context.input, item, index },
    };
    let failed = false;
    let result: unknown;
    try {
        for await (const signal of runChild(templateChildId, itemContext)) {
            signals.push(signal);
            if (signal.type === 'success') {
                result = signal.result;
            }
            if (isFailureSignal(signal)) {
                failed = true;
            }
        }
    } catch (cause) {
        failed = true;
        signals.push({
            type: 'failure',
            graphId: context.graphId,
            nodeId: `${templateChildId}:${index}`,
            error: {
                code: 'parallel_fanout_item_threw',
                childId: templateChildId,
                index,
                message: cause instanceof Error ? cause.message : String(cause),
            },
        });
    }
    return {
        index,
        signals,
        failed,
        ...(result !== undefined ? { result } : {}),
    };
}

function indices(start: number, end: number): readonly number[] {
    const out: number[] = [];
    for (let i = start; i < end; i++) {
        out.push(i);
    }
    return out;
}
