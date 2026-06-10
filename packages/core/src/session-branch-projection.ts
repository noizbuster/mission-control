import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { SessionBranchNode, SessionBranchSummary, SessionBranchTree } from './session-replay-types.js';

type MutableBranchNode = {
    readonly eventId: string;
    readonly sequence: number;
    readonly parentEventId?: string;
    readonly childEventIds: string[];
    readonly eventType: AgentEventEnvelope['event']['type'];
    readonly timestamp: string;
    readonly message?: string;
};

export function projectSessionBranchTree(input: {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): SessionBranchTree {
    const nodes = new Map<string, MutableBranchNode>();
    let previousEventId: string | undefined;
    let activeLeafId: string | undefined;

    for (const envelope of input.envelopes) {
        const parentEventId = envelope.causationId ?? previousEventId;
        const node = createBranchNode(envelope, parentEventId);
        nodes.set(envelope.eventId, node);
        if (parentEventId !== undefined) {
            nodes.get(parentEventId)?.childEventIds.push(envelope.eventId);
        }
        previousEventId = envelope.eventId;
        activeLeafId = envelope.eventId;
    }

    return {
        sessionId: input.sessionId,
        ...(activeLeafId !== undefined ? { activeLeafId } : {}),
        nodes: [...nodes.values()].map(toReadonlyBranchNode),
    };
}

export function projectBranchSummaries(branchTree: SessionBranchTree): readonly SessionBranchSummary[] {
    const nodesById = new Map(branchTree.nodes.map((node) => [node.eventId, node]));
    const leaves = branchTree.nodes.filter((node) => node.childEventIds.length === 0);
    return leaves.map((leaf) => summarizeLeaf(leaf, nodesById));
}

function createBranchNode(envelope: AgentEventEnvelope, parentEventId: string | undefined): MutableBranchNode {
    return {
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        ...(parentEventId !== undefined ? { parentEventId } : {}),
        childEventIds: [],
        eventType: envelope.event.type,
        timestamp: envelope.event.timestamp,
        ...(envelope.event.message !== undefined ? { message: envelope.event.message } : {}),
    };
}

function toReadonlyBranchNode(node: MutableBranchNode): SessionBranchNode {
    return {
        eventId: node.eventId,
        sequence: node.sequence,
        ...(node.parentEventId !== undefined ? { parentEventId: node.parentEventId } : {}),
        childEventIds: [...node.childEventIds],
        eventType: node.eventType,
        timestamp: node.timestamp,
        ...(node.message !== undefined ? { message: node.message } : {}),
    };
}

function summarizeLeaf(
    leaf: SessionBranchNode,
    nodesById: ReadonlyMap<string, SessionBranchNode>,
): SessionBranchSummary {
    const path = pathToLeaf(leaf, nodesById);
    const lastMessage = [...path].reverse().find((node) => node.message !== undefined)?.message;
    return {
        leafEventId: leaf.eventId,
        eventIds: path.map((node) => node.eventId),
        eventCount: path.length,
        ...(lastMessage !== undefined ? { lastMessage } : {}),
    };
}

function pathToLeaf(
    leaf: SessionBranchNode,
    nodesById: ReadonlyMap<string, SessionBranchNode>,
): readonly SessionBranchNode[] {
    const path: SessionBranchNode[] = [];
    let cursor: SessionBranchNode | undefined = leaf;
    while (cursor !== undefined) {
        path.unshift(cursor);
        cursor = cursor.parentEventId === undefined ? undefined : nodesById.get(cursor.parentEventId);
    }
    return path;
}
