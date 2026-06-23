// allow: SIZE_OK -- indivisible ABG overlay state module. The work plan mandates a single
// projector module exporting the state shape, its external store, and every pure projector
// that folds into that state. Splitting would scatter tightly-coupled symbols the plan
// requires to live together (todos 2-9 all import from this one path).

import { redactCredentialText } from '../providers/credential-resolver.js';
import type {
    AbgGraphSnapshot,
    AbgGraphStatus,
    AbgNodeStatus,
    AbgSignal,
    AbgToolOutcomeSnapshot,
    AgentEvent,
    ApprovalRecord,
} from '@mission-control/protocol';

export type RunState = 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked_on_approval';

export type RecentEvent = {
    readonly timestamp: string;
    readonly type: string;
    readonly nodeId?: string;
    readonly signal?: string;
    readonly message: string;
    readonly emitPayloadText?: string;
};

export type GraphSummary = {
    readonly graphId: string;
    readonly status: AbgGraphStatus;
    readonly parentGraphId?: string;
    readonly nodeCount: number;
    readonly eventCount: number;
    readonly lastUpdated: string;
};

export type AbgOverlayEdge = {
    readonly source: string;
    readonly target: string;
    readonly condition?: string;
};

export type AbgOverlayState = {
    readonly activeGraphId: string | undefined;
    readonly focusedGraphId: string | undefined;
    readonly graphStatus: AbgGraphStatus | undefined;
    readonly nodes: ReadonlyMap<string, AbgNodeStatus>;
    readonly graphEdges: readonly AbgOverlayEdge[];
    readonly activeNodeIds: readonly string[];
    readonly toolOutcomes: readonly AbgToolOutcomeSnapshot[];
    readonly recentEvents: readonly RecentEvent[];
    readonly pendingApprovals: readonly ApprovalRecord[];
    readonly blackboardEntries: ReadonlyMap<string, unknown>;
    readonly knownGraphIds: readonly string[];
    readonly graphs: ReadonlyMap<string, GraphSummary>;
    readonly costCents: number | undefined;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelCalls: number;
    readonly lastLiveDelta: string;
    readonly lastError: string | undefined;
    readonly runState: RunState;
    readonly nativeSidecarStatus: string;
    readonly lastSettledAt: string | undefined;
};

/**
 * Mutable twin of {@link AbgOverlayState} handed to `AbgOverlayStore.update` mutators. Structural
 * sibling (mutable collections) so callers can `.set`/`.push` while the published snapshot stays
 * readonly. Assignable to `AbgOverlayState`, which is how the store publishes a draft.
 */
export type AbgOverlayDraft = {
    activeGraphId: string | undefined;
    focusedGraphId: string | undefined;
    graphStatus: AbgGraphStatus | undefined;
    nodes: Map<string, AbgNodeStatus>;
    graphEdges: AbgOverlayEdge[];
    activeNodeIds: string[];
    toolOutcomes: AbgToolOutcomeSnapshot[];
    recentEvents: RecentEvent[];
    pendingApprovals: ApprovalRecord[];
    blackboardEntries: Map<string, unknown>;
    knownGraphIds: string[];
    graphs: Map<string, GraphSummary>;
    costCents: number | undefined;
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
    lastLiveDelta: string;
    lastError: string | undefined;
    runState: RunState;
    nativeSidecarStatus: string;
    lastSettledAt: string | undefined;
};

export interface AbgOverlayStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): AbgOverlayState;
    update(mutator: (draft: AbgOverlayDraft) => void): void;
    reset(): void;
    isActive(): boolean;
    setActive(value: boolean): void;
}

/**
 * Mutable partial built internally by the projectors. `Partial<AbgOverlayState>` keeps the
 * `readonly` modifier, so it cannot be assigned incrementally; this twin carries mutable
 * collections and is structurally assignable to `Partial<AbgOverlayState>` on return.
 */
type AbgOverlayPatch = {
    activeGraphId?: string;
    focusedGraphId?: string;
    graphStatus?: AbgGraphStatus;
    nodes?: Map<string, AbgNodeStatus>;
    graphEdges?: readonly AbgOverlayEdge[];
    activeNodeIds?: readonly string[];
    toolOutcomes?: readonly AbgToolOutcomeSnapshot[];
    recentEvents?: RecentEvent[];
    pendingApprovals?: readonly ApprovalRecord[];
    blackboardEntries?: Map<string, unknown>;
    knownGraphIds?: readonly string[];
    graphs?: Map<string, GraphSummary>;
    costCents?: number;
    inputTokens?: number;
    outputTokens?: number;
    modelCalls?: number;
    lastLiveDelta?: string;
    lastError?: string;
    runState?: RunState;
    nativeSidecarStatus?: string;
    lastSettledAt?: string;
};

export const RECENT_EVENTS_CAP = 200;
export const DEFAULT_REFRESH_MS = 33;
const MIN_REFRESH_MS = 16;

/** Wraps the core credential redactor with an empty secret list (matches existing CLI posture). */
export function redactForDisplay(text: string | undefined): string {
    return redactCredentialText(text ?? '', []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function updateGraphSummary(
    current: ReadonlyMap<string, GraphSummary>,
    graphId: string,
    parentGraphId: string | undefined,
): Map<string, GraphSummary> {
    const next = new Map(current);
    const existing = next.get(graphId);
    next.set(graphId, {
        graphId,
        status: existing?.status ?? 'active',
        ...(parentGraphId !== undefined && parentGraphId !== graphId && existing?.parentGraphId === undefined
            ? { parentGraphId }
            : existing?.parentGraphId !== undefined
              ? { parentGraphId: existing.parentGraphId }
              : {}),
        nodeCount: existing?.nodeCount ?? 0,
        eventCount: (existing?.eventCount ?? 0) + 1,
        lastUpdated: new Date().toISOString(),
    });
    return next;
}

function updateGraphSummaryFromEvent(
    current: ReadonlyMap<string, GraphSummary>,
    graphId: string,
    event: AgentEvent,
    parentGraphId: string | undefined,
): Map<string, GraphSummary> {
    const next = new Map(current);
    const existing = next.get(graphId);
    const statusFromEvent = graphStatusForEventType(event.type);
    next.set(graphId, {
        graphId,
        status: statusFromEvent ?? existing?.status ?? 'active',
        ...(parentGraphId !== undefined && parentGraphId !== graphId && existing?.parentGraphId === undefined
            ? { parentGraphId }
            : existing?.parentGraphId !== undefined
              ? { parentGraphId: existing.parentGraphId }
              : {}),
        nodeCount: existing?.nodeCount ?? 0,
        eventCount: (existing?.eventCount ?? 0) + 1,
        lastUpdated: event.timestamp,
    });
    return next;
}

function appendRecent(events: readonly RecentEvent[], entry: RecentEvent): RecentEvent[] {
    const next = [...events, entry];
    return next.length > RECENT_EVENTS_CAP ? next.slice(next.length - RECENT_EVENTS_CAP) : next;
}

function extractDeltaText(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
    if (isRecord(payload) && typeof payload['delta'] === 'string') {
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
        return payload['delta'];
    }
    return '';
}

function safePayloadText(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload);
    } catch {
        return '[unserializable]';
    }
}

function safeErrorText(error: unknown): string {
    if (typeof error === 'string') return error;
    // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
    if (isRecord(error) && typeof error['message'] === 'string') {
        // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
        return error['message'];
    }
    return safePayloadText(error);
}

function signalReason(signal: AbgSignal): string {
    switch (signal.type) {
        case 'cancel':
            return signal.reason ?? `cancel ${signal.target}`;
        case 'escalate':
            return signal.reason ?? (signal.target !== undefined ? `escalate ${signal.target}` : 'escalate');
        case 'fallback':
            return signal.reason ?? 'fallback';
        default:
            return '';
    }
}

function createDefaultState(): AbgOverlayDraft {
    return {
        activeGraphId: undefined,
        focusedGraphId: undefined,
        graphStatus: undefined,
        nodes: new Map(),
        graphEdges: [],
        activeNodeIds: [],
        toolOutcomes: [],
        recentEvents: [],
        pendingApprovals: [],
        blackboardEntries: new Map(),
        knownGraphIds: [],
        graphs: new Map(),
        costCents: undefined,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
        lastLiveDelta: '',
        lastError: undefined,
        runState: 'idle',
        nativeSidecarStatus: '',
        lastSettledAt: undefined,
    };
}

function cloneState(state: AbgOverlayState): AbgOverlayDraft {
    return {
        activeGraphId: state.activeGraphId,
        focusedGraphId: state.focusedGraphId,
        graphStatus: state.graphStatus,
        nodes: new Map(state.nodes),
        graphEdges: [...state.graphEdges],
        activeNodeIds: [...state.activeNodeIds],
        toolOutcomes: [...state.toolOutcomes],
        recentEvents: [...state.recentEvents],
        pendingApprovals: [...state.pendingApprovals],
        blackboardEntries: new Map(state.blackboardEntries),
        knownGraphIds: [...state.knownGraphIds],
        graphs: new Map(state.graphs),
        costCents: state.costCents,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        modelCalls: state.modelCalls,
        lastLiveDelta: state.lastLiveDelta,
        lastError: state.lastError,
        runState: state.runState,
        nativeSidecarStatus: state.nativeSidecarStatus,
        lastSettledAt: state.lastSettledAt,
    };
}

/**
 * Pure fold of an {@link AbgSignal} (plane A live source) into state. Total and non-throwing
 * (Metis 4.1): every error returns an empty patch so a malformed signal cannot reject the node run.
 * AbgSignal carries no timestamp outside its embedded `emit` event, so non-emit recent entries use
 * an empty timestamp placeholder (the integration layer may enrich it).
 */
export function projectAbgSignal(state: AbgOverlayState, signal: AbgSignal): Partial<AbgOverlayState> {
    try {
        return projectAbgSignalSafe(state, signal);
    } catch {
        return {};
    }
}

function projectAbgSignalSafe(state: AbgOverlayState, signal: AbgSignal): Partial<AbgOverlayState> {
    const nodes = new Map<string, AbgNodeStatus>(state.nodes);
    const patch: AbgOverlayPatch = {};
    if (signal.graphId !== undefined) {
        patch.activeGraphId = signal.graphId;
        if (state.focusedGraphId === undefined) {
            patch.focusedGraphId = signal.graphId;
        }
        patch.graphs = updateGraphSummary(state.graphs, signal.graphId, state.activeGraphId);
    }
    let entry: RecentEvent | undefined;

    switch (signal.type) {
        case 'started':
            nodes.set(signal.nodeId, 'running');
            entry = { timestamp: '', type: 'node.started', nodeId: signal.nodeId, signal: 'started', message: '' };
            break;
        case 'progress':
            nodes.set(signal.nodeId, 'running');
            entry = {
                timestamp: '',
                type: 'node.progress',
                nodeId: signal.nodeId,
                signal: 'progress',
                message: redactForDisplay(signal.message),
            };
            break;
        case 'success':
            nodes.set(signal.nodeId, 'succeeded');
            entry = { timestamp: '', type: 'node.completed', nodeId: signal.nodeId, signal: 'success', message: '' };
            break;
        case 'failure': {
            nodes.set(signal.nodeId, 'failed');
            const errorText = redactForDisplay(safeErrorText(signal.error));
            patch.lastError = errorText;
            entry = {
                timestamp: '',
                type: 'node.failed',
                nodeId: signal.nodeId,
                signal: 'failure',
                message: errorText,
            };
            break;
        }
        case 'cancelled':
            nodes.set(signal.nodeId, 'cancelled');
            entry = {
                timestamp: '',
                type: 'node.cancelled',
                nodeId: signal.nodeId,
                signal: 'cancelled',
                message: redactForDisplay(signal.reason),
            };
            break;
        case 'emit': {
            nodes.set(signal.nodeId, 'running');
            const eventType = signal.event.type;
            const redactedPayload = redactForDisplay(safePayloadText(signal.event.payload));
            if (eventType === 'llm.text.delta') {
                patch.lastLiveDelta = redactForDisplay(extractDeltaText(signal.event.payload));
            }
            entry = {
                timestamp: signal.event.timestamp,
                type: eventType,
                nodeId: signal.nodeId,
                signal: 'emit',
                message: redactedPayload,
                emitPayloadText: redactedPayload,
            };
            break;
        }
        case 'select':
            nodes.set(signal.nodeId, 'running');
            entry = {
                timestamp: '',
                type: 'node.select',
                nodeId: signal.nodeId,
                signal: 'select',
                message: redactForDisplay(`select -> ${signal.target}`),
            };
            break;
        case 'transition':
            nodes.set(signal.nodeId, 'running');
            entry = {
                timestamp: '',
                type: 'node.transition',
                nodeId: signal.nodeId,
                signal: 'transition',
                message: redactForDisplay(`${signal.from} -> ${signal.to}`),
            };
            break;
        case 'spawn':
            nodes.set(signal.nodeId, 'running');
            if (signal.graphId !== undefined && !state.knownGraphIds.includes(signal.graphId)) {
                patch.knownGraphIds = [...state.knownGraphIds, signal.graphId];
            }
            entry = {
                timestamp: '',
                type: 'node.spawn',
                nodeId: signal.nodeId,
                signal: 'spawn',
                message: redactForDisplay(`spawn ${signal.actor}`),
            };
            break;
        case 'cancel':
        case 'escalate':
        case 'fallback':
            // Control-intent signals with no node-status mapping in the spec; record for timeline only.
            entry = {
                timestamp: '',
                type: `signal.${signal.type}`,
                nodeId: signal.nodeId,
                signal: signal.type,
                message: redactForDisplay(signalReason(signal)),
            };
            break;
    }

    patch.nodes = nodes;
    if (entry !== undefined) {
        patch.recentEvents = appendRecent(state.recentEvents, entry);
    }
    return patch;
}

const OVERLAY_EVENT_PREFIXES = [
    'graph.',
    'node.',
    'attempt.',
    'model.call.',
    'tool.',
    'command.',
    'file.diff.',
    'approval.',
    'run.',
    'native.',
] as const;
const OVERLAY_EVENT_EXACT: ReadonlySet<string> = new Set([
    'workflow.transitioned',
    'decision.selected',
    'policy.blocked',
]);

function shouldProjectEvent(event: AgentEvent): boolean {
    if (event.abg?.graphId !== undefined) return true;
    const type = event.type;
    if (OVERLAY_EVENT_EXACT.has(type)) return true;
    return OVERLAY_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function runStateForEventType(type: string): RunState | undefined {
    switch (type) {
        case 'run.started':
            return 'running';
        case 'run.completed':
            return 'completed';
        case 'run.failed':
            return 'failed';
        case 'run.interrupted':
            return 'interrupted';
        case 'run.blocked':
            return 'blocked_on_approval';
        case 'run.idle':
            return 'idle';
        default:
            return undefined;
    }
}

function graphStatusForEventType(type: string): AbgGraphStatus | undefined {
    switch (type) {
        case 'graph.started':
            return 'active';
        case 'graph.completed':
            return 'completed';
        case 'graph.failed':
            return 'failed';
        case 'graph.cancelled':
            return 'cancelled';
        default:
            return undefined;
    }
}

/**
 * Pure fold of a durable {@link AgentEvent} (plane B) into state. Filters to overlay-relevant
 * events (abg.graphId present OR a runtime/approval/command/diff/model/... type), updates runState
 * and graphStatus for lifecycle events, accumulates token usage on `model.call.completed`, and
 * appends a redacted recentEvents entry. costCents is never derived here (Metis 1.4: no pricing
 * table ships).
 */
export function projectAgentEvent(state: AbgOverlayState, event: AgentEvent): Partial<AbgOverlayState> {
    if (!shouldProjectEvent(event)) {
        return {};
    }
    const patch: AbgOverlayPatch = {};
    const abg = event.abg;
    if (abg?.graphId !== undefined) {
        patch.activeGraphId = abg.graphId;
        if (state.focusedGraphId === undefined) {
            patch.focusedGraphId = abg.graphId;
        }
        patch.graphs = updateGraphSummaryFromEvent(state.graphs, abg.graphId, event, state.activeGraphId);
    }

    const runState = runStateForEventType(event.type);
    if (runState !== undefined) {
        patch.runState = runState;
    }
    if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.interrupted' ||
        event.type === 'run.blocked'
    ) {
        patch.lastSettledAt = event.timestamp;
    }

    const graphStatus = graphStatusForEventType(event.type);
    if (graphStatus !== undefined) {
        patch.graphStatus = graphStatus;
    }

    if (event.type === 'native.status' && event.nativeSidecarStatus !== undefined) {
        patch.nativeSidecarStatus = event.nativeSidecarStatus;
    }

    if (event.type === 'model.call.completed') {
        const usage = extractUsageFromModelCallCompleted(event);
        if (usage !== undefined) {
            patch.inputTokens = state.inputTokens + usage.inputTokens;
            patch.outputTokens = state.outputTokens + usage.outputTokens;
            patch.modelCalls = state.modelCalls + 1;
        }
    }

    if (event.type === 'policy.budget.accumulated') {
        const payload = extractBudgetPayload(event);
        if (payload !== undefined) {
            patch.costCents = payload.cents;
            patch.inputTokens = payload.inputTokens;
            patch.outputTokens = payload.outputTokens;
            patch.modelCalls = payload.modelCalls;
        }
    }

    if (event.type === 'blackboard.set' || event.type === 'blackboard.delete') {
        const mutation = extractBlackboardMutation(event);
        if (mutation !== undefined) {
            const next = new Map(state.blackboardEntries);
            if (mutation.kind === 'blackboard.set' && mutation.value !== undefined) {
                next.set(mutation.key, mutation.value);
            } else if (mutation.kind === 'blackboard.delete') {
                next.delete(mutation.key);
            }
            patch.blackboardEntries = next;
        }
    }

    patch.recentEvents = appendRecent(state.recentEvents, {
        timestamp: event.timestamp,
        type: event.type,
        message: redactForDisplay(event.message),
        ...(abg?.nodeId !== undefined ? { nodeId: abg.nodeId } : {}),
        ...(abg?.signalType !== undefined ? { signal: abg.signalType } : {}),
    });
    return patch;
}

function redactToolOutcome(outcome: AbgToolOutcomeSnapshot): AbgToolOutcomeSnapshot {
    if (outcome.lastMessage === undefined) return outcome;
    return { ...outcome, lastMessage: redactForDisplay(outcome.lastMessage) };
}

function recentEventFromSignal(signal: AbgSignal): RecentEvent {
    return {
        timestamp: signal.type === 'emit' ? signal.event.timestamp : '',
        type: signal.type === 'emit' ? signal.event.type : `signal.${signal.type}`,
        nodeId: signal.nodeId,
        signal: signal.type,
        message: '',
    };
}

/**
 * Pure overlay of durable-derived fields from {@link AbgGraphSnapshot} (polled at the refresh
 * tick). Settled node statuses, active node ids, tool outcomes, and pending approvals come from the
 * snapshot; live node entries not present in the snapshot are preserved. toolOutcomes.lastMessage
 * is redacted. When `lastSignal` is present it is folded into recentEvents so the durable tail is
 * observable.
 */
export function mergeGraphSnapshot(state: AbgOverlayState, snapshot: AbgGraphSnapshot): Partial<AbgOverlayState> {
    const nodes = new Map<string, AbgNodeStatus>(state.nodes);
    for (const node of snapshot.nodes) {
        nodes.set(node.nodeId, node.status);
    }
    const patch: AbgOverlayPatch = {
        activeGraphId: snapshot.graphId,
        graphStatus: snapshot.status,
        activeNodeIds: [...snapshot.activeNodeIds],
        nodes,
        toolOutcomes: snapshot.toolOutcomes.map(redactToolOutcome),
        pendingApprovals: [...snapshot.approvals],
    };
    if (snapshot.lastSignal !== undefined) {
        patch.recentEvents = appendRecent(state.recentEvents, recentEventFromSignal(snapshot.lastSignal));
    }
    return patch;
}

/**
 * Primary cost source (Metis 1.4). Reads token usage off the `response_completed` provider stream
 * chunk on a `model.call.completed` event. `costCents` is always absent here — pricing-derived cents
 * arrive via `policy.budget.accumulated` events emitted by `CostLedger.accumulate()` and folded in
 * by the dedicated branch in `projectAgentEvent`.
 */
export function extractUsageFromModelCallCompleted(
    event: AgentEvent,
): { inputTokens: number; outputTokens: number; costCents?: number } | undefined {
    if (event.type !== 'model.call.completed') return undefined;
    const chunk = event.providerStreamChunk;
    if (chunk === undefined || chunk.kind !== 'response_completed') return undefined;
    const usage = chunk.usage;
    if (usage === undefined) return undefined;
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

type BudgetPayload = {
    readonly cents: number;
    readonly budgetCents?: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelCalls: number;
};

/**
 * Reads the running cost totals off a `policy.budget.accumulated` durable event. The payload is
 * emitted by `CostLedger.accumulate()` and persisted on `event.abg.emit.payload` (v2). Returns
 * `undefined` when the payload is missing or malformed — the projector leaves `costCents`
 * untouched in that case.
 */
export function extractBudgetPayload(event: AgentEvent): BudgetPayload | undefined {
    if (event.type !== 'policy.budget.accumulated') return undefined;
    const payload = event.abg?.emit?.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    const cents = record['cents'];
    const inputTokens = record['inputTokens'];
    const outputTokens = record['outputTokens'];
    const modelCalls = record['modelCalls'];
    if (
        typeof cents !== 'number' ||
        typeof inputTokens !== 'number' ||
        typeof outputTokens !== 'number' ||
        typeof modelCalls !== 'number'
    ) {
        return undefined;
    }
    const budgetCents = record['budgetCents'];
    return {
        cents,
        inputTokens,
        outputTokens,
        modelCalls,
        ...(typeof budgetCents === 'number' ? { budgetCents } : {}),
    };
}

type BlackboardMutation = {
    readonly kind: 'blackboard.set' | 'blackboard.delete';
    readonly key: string;
    readonly value?: unknown;
};

export function extractBlackboardMutation(event: AgentEvent): BlackboardMutation | undefined {
    if (event.type !== 'blackboard.set' && event.type !== 'blackboard.delete') return undefined;
    const payload = event.abg?.emit?.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0) return undefined;
    const value = record['value'];
    return {
        kind: event.type,
        key,
        ...(value !== undefined ? { value } : {}),
    };
}

/**
 * External store factory (mirrors the `EventBus` subscribe pattern). `getSnapshot()` is
 * referentially stable until `update()` or `reset()` rebuilds it. `update` clones the current
 * snapshot into a mutable draft, applies the mutator, and publishes the draft so the previous
 * snapshot is never mutated. `reset()` returns every field to its default (Metis 5.3 no-leak).
 */
export function createAbgOverlayStore(): AbgOverlayStore {
    const listeners = new Set<() => void>();
    let snapshot: AbgOverlayDraft = createDefaultState();
    let active = false;

    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot() {
            return snapshot;
        },
        update(mutator) {
            const draft = cloneState(snapshot);
            mutator(draft);
            snapshot = draft;
            notify();
        },
        reset() {
            snapshot = createDefaultState();
            notify();
        },
        isActive() {
            return active;
        },
        setActive(value) {
            active = value;
            notify();
        },
    };
}

/**
 * Reads `MCTRL_ABG_OVERLAY_REFRESH_MS`. Absent or non-numeric falls back to
 * {@link DEFAULT_REFRESH_MS} (33ms). Finite values below {@link MIN_REFRESH_MS} (16ms) are clamped
 * up to avoid thrashing Ink's render loop.
 */
export function readRefreshMsFromEnv(): number {
    // biome-ignore lint/complexity/useLiteralKeys: process.env (NodeJS.ProcessEnv) requires bracket access per noPropertyAccessFromIndexSignature
    const raw = process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
    if (raw === undefined) return DEFAULT_REFRESH_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_MS;
    return Math.max(MIN_REFRESH_MS, parsed);
}
