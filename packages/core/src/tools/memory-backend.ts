/**
 * Memory backend seam for the memory tools (retain, recall, reflect, memory_edit, learn,
 * manage_skill).
 *
 * This is a SEAM, not a wired store. Only two backends have runtime implementations:
 *  - `off`     — the default no-op state. Memory tools are NOT registered when this is
 *                active (the registration gate keys on `id === 'off'`).
 *  - `local`   — an in-memory-only stub. A process-local `Map` round-trips retain -> recall
 *                within one process. There is NO on-disk persistence: memories vanish when
 *                the process exits. This deliberately does not implement SQLite, a vector
 *                index, or a persistent store (AGENTS.md anti-pattern).
 *
 * The remaining catalog entries (`mnemopi`, `hindsight`) are deferred: they register and
 * advertise their tools (because `id !== 'off'`) but every method returns
 * `memory_backend_not_configured`. This mirrors the mission-control providers-without-
 * adapters convention — the catalog entry exists before the engine lands.
 *
 * Mirrors how `packages/core/src/tools/debug-tool.ts` defers execution behind a clean seam.
 */
import type { MemoryBackendId } from '@mission-control/protocol';

/** Shared status carried by every backend result. */
export type MemoryBackendStatus = 'ok' | 'empty' | 'memory_backend_not_configured';

/** One retained memory record. The `local` stub mints monotonically-numbered ids. */
export type MemoryRecord = {
    readonly id: string;
    readonly content: string;
    readonly context: string | undefined;
    readonly importance: number;
    readonly createdAt: string;
    readonly source: string | undefined;
};

/** A single retain item (matches the retain tool input shape). */
export type RetainItem = {
    readonly content: string;
    readonly context: string | undefined;
    readonly importance: number | undefined;
};

/** Result of a retain call. */
export type MemoryRetainResult = {
    readonly status: 'ok' | 'memory_backend_not_configured';
    readonly stored: number;
};

/** Result of a recall call. */
export type MemoryRecallResult = {
    readonly status: 'ok' | 'empty' | 'memory_backend_not_configured';
    readonly memories: readonly MemoryRecord[];
};

/** Result of a reflect call. The stub delegates to recall and formats the matches. */
export type MemoryReflectResult = {
    readonly status: 'ok' | 'empty' | 'memory_backend_not_configured';
    readonly text: string;
    readonly memories: readonly MemoryRecord[];
};

/** Edit parameters (matches the memory_edit tool input shape). */
export type MemoryEditParams = {
    readonly op: 'update' | 'forget' | 'invalidate';
    readonly id: string;
    readonly content: string | undefined;
    readonly importance: number | undefined;
    readonly replacementId: string | undefined;
};

/** Result of an edit call. */
export type MemoryEditResult = {
    readonly status: 'ok' | 'not_found' | 'memory_backend_not_configured';
    readonly id: string;
};

/**
 * The memory backend seam. Real implementations (a SQLite mnemopi engine, a remote
 * Hindsight client) would live behind this interface; until then the `local` stub serves
 * tests and the deferred backends serve the catalog seam.
 */
export interface MemoryBackend {
    readonly id: MemoryBackendId;
    retain(items: readonly RetainItem[]): Promise<MemoryRetainResult>;
    recall(query: string): Promise<MemoryRecallResult>;
    reflect(query: string, context?: string): Promise<MemoryReflectResult>;
    edit(params: MemoryEditParams): Promise<MemoryEditResult>;
}

export const MEMORY_BACKEND_NOT_CONFIGURED = 'memory_backend_not_configured' as const;

/** True when the backend should register and advertise its tools. `off` is the only gate. */
export function isMemoryBackendActive(backend: MemoryBackend): boolean {
    return backend.id !== 'off';
}

/**
 * In-memory-only `local` stub. Retain stores records in a process-local `Map`; recall does
 * a case-insensitive substring search over content + context. No persistence, no vector
 * index, no SQLite — the Map dies with the process. Sufficient for the retain -> recall
 * round-trip contract and for tests.
 */
export class LocalMemoryBackend implements MemoryBackend {
    readonly id = 'local' as const;
    private readonly store = new Map<string, MemoryRecord>();
    private counter = 0;

    async retain(items: readonly RetainItem[]): Promise<MemoryRetainResult> {
        for (const item of items) {
            this.counter += 1;
            const id = `mem-${this.counter}`;
            this.store.set(id, {
                id,
                content: item.content,
                context: item.context,
                importance: clampImportance(item.importance),
                createdAt: new Date().toISOString(),
                source: undefined,
            });
        }
        return { status: 'ok', stored: items.length };
    }

    async recall(query: string): Promise<MemoryRecallResult> {
        const memories = rankMemories([...this.store.values()], query);
        return { status: memories.length > 0 ? 'ok' : 'empty', memories };
    }

    async reflect(query: string, context?: string): Promise<MemoryReflectResult> {
        const effectiveQuery = context !== undefined && context.trim().length > 0 ? `${query} ${context}` : query;
        const memories = rankMemories([...this.store.values()], effectiveQuery);
        if (memories.length === 0) {
            return { status: 'empty', text: 'No relevant memories found to reflect on.', memories };
        }
        const formatted = memories.map((memory, index) => `${index + 1}. ${memory.content}`).join('\n');
        return { status: 'ok', text: `Based on recalled memories:\n${formatted}`, memories };
    }

    async edit(params: MemoryEditParams): Promise<MemoryEditResult> {
        const existing = this.store.get(params.id);
        if (existing === undefined) {
            return { status: 'not_found', id: params.id };
        }
        if (params.op === 'update') {
            this.store.set(params.id, {
                ...existing,
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.importance !== undefined ? { importance: clampImportance(params.importance) } : {}),
            });
            return { status: 'ok', id: params.id };
        }
        // `forget` and `invalidate` both remove the record in the stub. A real backend would
        // keep invalidated records in a superseded state; the in-memory stub has no such store.
        this.store.delete(params.id);
        return { status: 'ok', id: params.id };
    }
}

/**
 * Deferred backend for `off`, `mnemopi`, and `hindsight`. `off` is gated out at registration
 * (tools never advertise). `mnemopi` and `hindsight` register and advertise (catalog seam)
 * but return `memory_backend_not_configured` for every call until their engines are ported.
 */
export class DeferredMemoryBackend implements MemoryBackend {
    readonly id: MemoryBackendId;

    constructor(id: MemoryBackendId) {
        this.id = id;
    }

    async retain(_items: readonly RetainItem[]): Promise<MemoryRetainResult> {
        return { status: MEMORY_BACKEND_NOT_CONFIGURED, stored: 0 };
    }

    async recall(_query: string): Promise<MemoryRecallResult> {
        return { status: MEMORY_BACKEND_NOT_CONFIGURED, memories: [] };
    }

    async reflect(_query: string, _context?: string): Promise<MemoryReflectResult> {
        return { status: MEMORY_BACKEND_NOT_CONFIGURED, text: '', memories: [] };
    }

    async edit(_params: MemoryEditParams): Promise<MemoryEditResult> {
        return { status: MEMORY_BACKEND_NOT_CONFIGURED, id: '' };
    }
}

/**
 * Resolve a backend id to a {@linkcode MemoryBackend} instance. `local` returns the
 * in-memory stub; every other id returns a {@linkcode DeferredMemoryBackend} (the
 * registration gate drops `off`; `mnemopi`/`hindsight` register but defer execution).
 */
export function resolveMemoryBackend(id: MemoryBackendId): MemoryBackend {
    if (id === 'local') {
        return new LocalMemoryBackend();
    }
    return new DeferredMemoryBackend(id);
}

function clampImportance(value: number | undefined): number {
    if (value === undefined) {
        return 0.5;
    }
    return Math.max(0, Math.min(1, value));
}

/** Rank memories for a recall query: case-insensitive substring match on content + context,
 *  matches first (ordered by importance desc, then id), then non-matches excluded. */
function rankMemories(memories: readonly MemoryRecord[], query: string): readonly MemoryRecord[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
        return [...memories].sort(byImportanceThenId);
    }
    const terms = normalized.split(/\s+/).filter((term) => term.length > 0);
    return memories
        .map((memory) => ({ memory, score: scoreMemory(memory, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || byImportanceThenId(left.memory, right.memory))
        .map((entry) => entry.memory);
}

function scoreMemory(memory: MemoryRecord, terms: readonly string[]): number {
    const haystack = `${memory.content} ${memory.context ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (haystack.includes(term)) {
            score += 1;
        }
    }
    return score;
}

function byImportanceThenId(left: MemoryRecord, right: MemoryRecord): number {
    return right.importance - left.importance || left.id.localeCompare(right.id);
}
