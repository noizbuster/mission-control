import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { AbgNodeRunContext } from '../node-registry.js';
import { isFailureSignal, readPositiveIntConfig } from './composite-node-utils.js';

const DEFAULT_STATIC_PARALLEL_CONCURRENCY = 2;

type RunChild = (childId: string, context: AbgNodeRunContext) => AsyncIterable<AbgSignal>;

export type StaticParallelChildOutcome = {
    readonly childId: string;
    readonly signals: readonly AbgSignal[];
    readonly succeeded: boolean;
    readonly failed: boolean;
};

export async function collectStaticParallelOutcomes(
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
    runChild: RunChild,
): Promise<readonly StaticParallelChildOutcome[]> {
    const children = node.children ?? [];
    const concurrency = readPositiveIntConfig(node, 'concurrency') ?? DEFAULT_STATIC_PARALLEL_CONCURRENCY;
    const outcomes: StaticParallelChildOutcome[] = [];

    for (let start = 0; start < children.length; start += concurrency) {
        const wave = await Promise.all(
            children
                .slice(start, start + concurrency)
                .map((childId) => collectChildSignals(childId, context, runChild)),
        );
        outcomes.push(...wave);
    }

    return outcomes;
}

async function collectChildSignals(
    childId: string,
    context: AbgNodeRunContext,
    runChild: RunChild,
): Promise<StaticParallelChildOutcome> {
    const signals: AbgSignal[] = [];
    let succeeded = false;
    let failed = false;
    try {
        for await (const signal of runChild(childId, context)) {
            signals.push(signal);
            succeeded ||= signal.type === 'success';
            failed ||= isFailureSignal(signal);
        }
    } catch (cause) {
        failed = true;
        signals.push({
            type: 'failure',
            graphId: context.graphId,
            nodeId: childId,
            error: {
                code: 'parallel_child_threw',
                childId,
                message: cause instanceof Error ? cause.message : String(cause),
            },
        });
    }
    return { childId, signals, succeeded, failed };
}
