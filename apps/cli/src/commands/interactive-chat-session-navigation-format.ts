import type { JsonlSessionReplayPrefixProjection } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';

export function formatSessionSummary(sessionId: string, replay: JsonlSessionReplayPrefixProjection): string {
    const selection = latestSelection(replay);
    const tree = replay.projection.sessionTree;
    const summary = [
        `Session: ${sessionId}`,
        `Status: ${(replay.projection.snapshot.status ?? 'unknown').toString()}`,
        `Events: ${replay.projection.events.length}`,
        selection === undefined
            ? undefined
            : `Model: ${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`,
        tree.activeLeafId === undefined ? undefined : `Active leaf: ${tree.activeLeafId}`,
        tree.parentSessionId === undefined ? undefined : `Parent session: ${tree.parentSessionId}`,
    ].filter((line) => line !== undefined);
    return `${summary.join('\n')}\n`;
}

export function formatSessionTree(sessionId: string, replay: JsonlSessionReplayPrefixProjection): string {
    const roots = replay.projection.sessionTree.nodes
        .filter((node) => node.parentEntryId === undefined)
        .sort(bySequence);
    const nodesById = new Map(replay.projection.sessionTree.nodes.map((node) => [node.entryId, node]));
    const lines = [
        `Session tree: ${sessionId}`,
        `Active leaf: ${replay.projection.sessionTree.activeLeafId ?? 'none'}`,
    ];
    const visit = (entryId: string, depth: number) => {
        const node = nodesById.get(entryId);
        if (node === undefined) {
            return;
        }
        lines.push(
            `${node.entryId === replay.projection.sessionTree.activeLeafId ? '* ' : '  '}${'  '.repeat(depth)}${node.entryId}${node.message === undefined ? '' : ` ${node.message}`}`,
        );
        [...node.childEntryIds]
            .sort((left, right) => bySequence(nodesById.get(left), nodesById.get(right)))
            .forEach((childId) => {
                visit(childId, depth + 1);
            });
    };
    roots.forEach((node) => {
        visit(node.entryId, 0);
    });
    return `${lines.join('\n')}\n`;
}

export function latestSelection(replay: JsonlSessionReplayPrefixProjection): ModelProviderSelection | undefined {
    return [...replay.projection.events].reverse().find((event) => event.modelProviderSelection !== undefined)
        ?.modelProviderSelection;
}

function bySequence(
    left: { readonly sequence: number } | undefined,
    right: { readonly sequence: number } | undefined,
): number {
    return (left?.sequence ?? Number.MAX_SAFE_INTEGER) - (right?.sequence ?? Number.MAX_SAFE_INTEGER);
}
