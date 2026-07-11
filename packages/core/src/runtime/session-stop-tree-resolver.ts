import type { Client } from '@libsql/client';
import { z } from 'zod';

export const SESSION_STOP_TREE_MAX_SESSIONS = 4_096;
export type CanonicalSessionLifecycleStatus = 'idle' | 'running' | 'awaiting' | 'stopped' | 'failed';

export type CanonicalSessionTreeSession = {
    readonly sessionId: string;
    readonly parentSessionId: string | null;
    readonly status?: CanonicalSessionLifecycleStatus;
};

export type CanonicalSessionTreeRelation = {
    readonly parentSessionId: string | null;
    readonly childSessionId: string;
    readonly kind: string;
};

export type CanonicalSessionTreeNode = CanonicalSessionTreeSession;
export type CanonicalSessionTreeDescendant = CanonicalSessionTreeNode & { readonly depth: number };
export type CanonicalSessionTreeResult =
    | {
          readonly ok: true;
          readonly targetSessionId: string;
          readonly nodes: readonly CanonicalSessionTreeNode[];
          readonly descendants: readonly CanonicalSessionTreeDescendant[];
      }
    | { readonly ok: false; readonly errorCode: 'session_not_found' | 'unstable_session_tree' };

const sessionRowSchema = z.object({
    session_id: z.string(),
    parent_session_id: z.string().nullable(),
    status: z.enum(['idle', 'running', 'awaiting', 'stopped', 'failed']),
});
const relationRowSchema = z.object({
    parent_session_id: z.string().nullable(),
    child_session_id: z.string(),
    kind: z.string(),
});
const executionRelationKinds = new Set(['parent_child', 'subagent']);

export async function readCanonicalSessionTree(
    client: Client,
    targetSessionId: string,
): Promise<CanonicalSessionTreeResult> {
    const [sessions, relations] = await Promise.all([
        client.execute('SELECT session_id, parent_session_id, status FROM sessions ORDER BY session_id'),
        client.execute(
            "SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE kind IN ('parent_child', 'subagent') ORDER BY child_session_id, relation_id",
        ),
    ]);
    return resolveCanonicalSessionTree({
        targetSessionId,
        sessions: sessions.rows.map((row) => {
            const parsed = sessionRowSchema.parse(row);
            return { sessionId: parsed.session_id, parentSessionId: parsed.parent_session_id, status: parsed.status };
        }),
        relations: relations.rows.map((row) => {
            const parsed = relationRowSchema.parse(row);
            return {
                parentSessionId: parsed.parent_session_id,
                childSessionId: parsed.child_session_id,
                kind: parsed.kind,
            };
        }),
    });
}

export function resolveCanonicalSessionTree(input: {
    readonly targetSessionId: string;
    readonly sessions: readonly CanonicalSessionTreeSession[];
    readonly relations: readonly CanonicalSessionTreeRelation[];
}): CanonicalSessionTreeResult {
    const sessions = new Map<string, CanonicalSessionTreeSession>();
    const inconsistent = new Set<string>();
    for (const session of input.sessions) {
        const existing = sessions.get(session.sessionId);
        if (existing === undefined) sessions.set(session.sessionId, session);
        else if (existing.parentSessionId !== session.parentSessionId || existing.status !== session.status) {
            inconsistent.add(session.sessionId);
        }
    }
    if (!sessions.has(input.targetSessionId)) return { ok: false, errorCode: 'session_not_found' };

    const fallbackByChild = new Map<string, CanonicalSessionTreeRelation[]>();
    for (const relation of input.relations) {
        if (!executionRelationKinds.has(relation.kind) || relation.parentSessionId === null) continue;
        const child = sessions.get(relation.childSessionId);
        if (child === undefined || child.parentSessionId !== null) continue;
        const candidates = fallbackByChild.get(relation.childSessionId) ?? [];
        candidates.push(relation);
        fallbackByChild.set(relation.childSessionId, candidates);
    }

    const parentBySession = new Map<string, string | null>();
    const adjacency = new Map<string, Set<string>>();
    for (const sessionId of sessions.keys()) adjacency.set(sessionId, new Set());
    for (const session of sessions.values()) {
        const explicit = session.parentSessionId;
        if (explicit !== null) {
            parentBySession.set(session.sessionId, explicit);
            recordCandidateEdge(session.sessionId, explicit, sessions, adjacency, inconsistent);
            continue;
        }
        const fallbacks = fallbackByChild.get(session.sessionId) ?? [];
        if (fallbacks.length === 0) {
            parentBySession.set(session.sessionId, null);
            continue;
        }
        if (fallbacks.length > 1) inconsistent.add(session.sessionId);
        const fallback = fallbacks[0];
        const parentId = fallback?.parentSessionId ?? null;
        parentBySession.set(session.sessionId, parentId);
        if (parentId !== null) recordCandidateEdge(session.sessionId, parentId, sessions, adjacency, inconsistent);
        for (const candidate of fallbacks.slice(1)) {
            const candidateParent = candidate.parentSessionId;
            if (candidateParent !== null) {
                recordCandidateEdge(session.sessionId, candidateParent, sessions, adjacency, inconsistent);
            }
        }
    }

    const component = collectComponent(input.targetSessionId, adjacency);
    if (component.size > SESSION_STOP_TREE_MAX_SESSIONS) {
        return { ok: false, errorCode: 'unstable_session_tree' };
    }
    if ([...component].some((sessionId) => inconsistent.has(sessionId)) || hasCycle(component, parentBySession)) {
        return { ok: false, errorCode: 'unstable_session_tree' };
    }

    const descendants = collectDescendants(input.targetSessionId, component, parentBySession, sessions);
    const nodes = [...component].sort(compareUtf8).map((sessionId) => treeNode(sessionId, parentBySession, sessions));
    return { ok: true, targetSessionId: input.targetSessionId, nodes, descendants };
}

function recordCandidateEdge(
    childId: string,
    parentId: string,
    sessions: ReadonlyMap<string, CanonicalSessionTreeSession>,
    adjacency: Map<string, Set<string>>,
    inconsistent: Set<string>,
): void {
    if (childId === parentId || !sessions.has(parentId)) {
        inconsistent.add(childId);
        return;
    }
    adjacency.get(childId)?.add(parentId);
    adjacency.get(parentId)?.add(childId);
}

function collectComponent(targetSessionId: string, adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
    const component = new Set([targetSessionId]);
    const pending = [targetSessionId];
    while (pending.length > 0) {
        const current = pending.shift();
        if (current === undefined) break;
        for (const related of adjacency.get(current) ?? []) {
            if (component.has(related)) continue;
            component.add(related);
            pending.push(related);
        }
    }
    return component;
}

function hasCycle(component: ReadonlySet<string>, parents: ReadonlyMap<string, string | null>): boolean {
    for (const sessionId of component) {
        const seen = new Set<string>();
        let current: string | null = sessionId;
        while (current !== null && component.has(current)) {
            if (seen.has(current)) return true;
            seen.add(current);
            current = parents.get(current) ?? null;
        }
    }
    return false;
}

function collectDescendants(
    targetSessionId: string,
    component: ReadonlySet<string>,
    parents: ReadonlyMap<string, string | null>,
    sessions: ReadonlyMap<string, CanonicalSessionTreeSession>,
): CanonicalSessionTreeDescendant[] {
    const children = new Map<string, string[]>();
    for (const sessionId of component) {
        const parentId = parents.get(sessionId) ?? null;
        if (parentId === null || !component.has(parentId)) continue;
        const siblings = children.get(parentId) ?? [];
        siblings.push(sessionId);
        children.set(parentId, siblings);
    }
    const descendants: CanonicalSessionTreeDescendant[] = [];
    let level = [targetSessionId];
    for (let depth = 1; level.length > 0; depth += 1) {
        const next = level.flatMap((parentId) => (children.get(parentId) ?? []).sort(compareUtf8));
        descendants.push(...next.map((sessionId) => ({ ...treeNode(sessionId, parents, sessions), depth })));
        level = next;
    }
    return descendants;
}

function treeNode(
    sessionId: string,
    parents: ReadonlyMap<string, string | null>,
    sessions: ReadonlyMap<string, CanonicalSessionTreeSession>,
): CanonicalSessionTreeNode {
    const status = sessions.get(sessionId)?.status;
    return {
        sessionId,
        parentSessionId: parents.get(sessionId) ?? null,
        ...(status !== undefined ? { status } : {}),
    };
}

function compareUtf8(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
