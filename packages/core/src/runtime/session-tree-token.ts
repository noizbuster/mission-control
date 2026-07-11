import { createHash } from 'node:crypto';

export type CanonicalSessionTreeTokenNode = {
    readonly sessionId: string;
    readonly parentSessionId: string | null;
    readonly depth: number;
};

export function encodeCanonicalSessionTree(nodes: readonly CanonicalSessionTreeTokenNode[]): string {
    return nodes
        .map(({ sessionId, parentSessionId, depth }) => `${depth}\0${parentSessionId ?? ''}\0${sessionId}`)
        .join('\n');
}

export function computeCanonicalSessionTreeToken(nodes: readonly CanonicalSessionTreeTokenNode[]): string {
    return createHash('sha256').update(encodeCanonicalSessionTree(nodes), 'utf8').digest('hex');
}
