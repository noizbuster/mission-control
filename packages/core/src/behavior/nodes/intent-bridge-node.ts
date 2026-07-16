/**
 * Deterministic intent bridge (Decision 16).
 *
 * After assess-ambiguity, maps ambiguity.classification → blackboard `intent`
 * when the classification is clear|unclear. on-the-fence leaves intent unset.
 * Never LLM-judged.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { createAbgEmitSignal } from '../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import { DUAL_INTENT_VALUES, type DualIntent } from '../planner-dual-review';

const AMBIGUITY_KEY = 'ambiguity.classification';
const INTENT_KEY = 'intent';

export const runIntentBridgeNode: AbgNodeRunner = async function* (
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    const nodeId = node.id;
    const graphIdPart = { graphId: context.graphId };
    yield { type: 'started', nodeId, ...graphIdPart };

    const blackboard = context.blackboard;
    if (blackboard === undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: {
                code: 'memory_unavailable',
                message: 'intent-bridge requires a blackboard',
            },
        };
        return;
    }

    const classification = blackboard.get(AMBIGUITY_KEY);
    const intent = isDualIntent(classification) ? classification : undefined;
    if (intent !== undefined) {
        blackboard.set(INTENT_KEY, intent);
    }

    yield createAbgEmitSignal({
        graphId: context.graphId,
        nodeId,
        source: 'intent-bridge',
        eventType: 'intent_bridge.evaluated',
        timestamp: context.now(),
        payload: {
            ambiguity_classification: typeof classification === 'string' ? classification : null,
            intent: intent ?? null,
            wrote_intent: intent !== undefined,
        },
    });
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: {
            intent: intent ?? null,
            [AMBIGUITY_KEY]: classification ?? null,
        },
    };
};

function isDualIntent(value: unknown): value is DualIntent {
    return typeof value === 'string' && (DUAL_INTENT_VALUES as readonly string[]).includes(value);
}
