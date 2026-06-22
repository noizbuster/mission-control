/**
 * RuntimeAgentRegistry - Process-global registry of live agent sessions.
 *
 * Tracks the main interactive session plus every subagent and advisor by
 * stable id. Advisors are observability-only: they are hidden from peer
 * rosters (`listVisibleTo`) and are never messageable.
 *
 * This registry tracks state only. Idle/park/revive lifecycle is owned by
 * AgentLifecycleManager (todo 16). In-memory only; no persistence.
 */

export const MAIN_AGENT_ID = 'Main';

export type AgentStatus = 'running' | 'idle' | 'parked' | 'aborted';
export type AgentKind = 'main' | 'sub' | 'advisor';

export interface AgentRef {
    readonly id: string;
    readonly displayName: string;
    readonly kind: AgentKind;
    readonly parentId?: string;
    status: AgentStatus;
    readonly sessionId: string;
    sessionFile?: string;
    readonly createdAt: string;
    lastActivity: string;
    activity?: string;
}

export type AgentRefInput = Omit<AgentRef, 'createdAt' | 'lastActivity'>;

export interface AdoptOptions {
    /**
     * Reserved for AgentLifecycleManager (todo 16). This registry ignores it;
     * callers pass it for API stability so the lifecycle manager can adopt the
     * same input shape when it wraps or intercepts adopt calls.
     */
    readonly idleTtlMs?: number;
}

export type AgentUpdatePatch = Partial<Pick<AgentRef, 'status' | 'lastActivity' | 'activity' | 'sessionFile'>>;

export class RuntimeAgentRegistry {
    private readonly refs = new Map<string, AgentRef>();

    /**
     * Register a live agent ref, stamping `createdAt` and `lastActivity`.
     *
     * The main interactive session (`MAIN_AGENT_ID`) is never adopted as a
     * tracked child: the call is a silent no-op so callers can uniformly
     * adopt without special-casing the main id.
     */
    adopt(ref: AgentRefInput, opts?: AdoptOptions): void {
        if (ref.id === MAIN_AGENT_ID) return;
        void opts;
        const now = new Date().toISOString();
        const stamped: AgentRef = {
            ...ref,
            createdAt: now,
            lastActivity: now,
        };
        this.refs.set(stamped.id, stamped);
    }

    /** Remove a ref from the registry. Unknown ids are a no-op. */
    release(id: string): void {
        this.refs.delete(id);
    }

    lookup(id: string): AgentRef | undefined {
        return this.refs.get(id);
    }

    /**
     * Peer-visible roster for the caller: every tracked agent except the caller
     * itself and every advisor. Advisors are observability-only transcripts,
     * never peers, so they are excluded from agent-facing rosters.
     */
    listVisibleTo(id: string): readonly AgentRef[] {
        const visible: AgentRef[] = [];
        for (const ref of this.refs.values()) {
            if (ref.id === id) continue;
            if (ref.kind === 'advisor') continue;
            visible.push(ref);
        }
        return visible;
    }

    /**
     * Merge a partial patch into an existing ref. Only `status`,
     * `lastActivity`, `activity`, and `sessionFile` are mutable. Fields absent
     * from the patch are left untouched. Unknown ids are a no-op.
     */
    update(id: string, patch: AgentUpdatePatch): void {
        const ref = this.refs.get(id);
        if (ref === undefined) return;
        if (patch.status !== undefined) ref.status = patch.status;
        if (patch.lastActivity !== undefined) ref.lastActivity = patch.lastActivity;
        if (patch.activity !== undefined) ref.activity = patch.activity;
        if (patch.sessionFile !== undefined) ref.sessionFile = patch.sessionFile;
    }

    /** Remove every tracked ref. */
    clear(): void {
        this.refs.clear();
    }
}

let registry: RuntimeAgentRegistry | undefined;

export function getRuntimeRegistry(): RuntimeAgentRegistry {
    if (registry === undefined) {
        registry = new RuntimeAgentRegistry();
    }
    return registry;
}
