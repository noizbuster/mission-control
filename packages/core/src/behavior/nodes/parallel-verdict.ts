import type { AbgNodeSpec } from '@mission-control/protocol';
import type { AbgNodeRunContext } from '../node-registry.js';
import { readStringArrayConfig, readStringConfig } from './composite-node-utils.js';

export type ParallelVerdict = {
    readonly value: 'APPROVE' | 'REJECT';
    readonly sources: readonly string[];
    readonly values: readonly unknown[];
    readonly verdictKey: string | undefined;
    readonly aggregateKey: string | undefined;
};

export function runAllApproveVerdict(node: AbgNodeSpec, context: AbgNodeRunContext): ParallelVerdict | undefined {
    if (readStringConfig(node, 'verdictStrategy') !== 'all-approve') {
        return undefined;
    }
    const sources = readStringArrayConfig(node, 'verdictSources');
    const values = sources.map((source) => context.blackboard?.get(source));
    const value = sources.length > 0 && values.every((verdict) => verdict === 'APPROVE') ? 'APPROVE' : 'REJECT';
    return {
        value,
        sources,
        values,
        verdictKey: readStringConfig(node, 'verdictKey'),
        aggregateKey: readStringConfig(node, 'aggregateKey'),
    };
}
