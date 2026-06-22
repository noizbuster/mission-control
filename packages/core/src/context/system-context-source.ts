/**
 * System Context Source algebra — ABG Context Packer foundation.
 *
 * Ports the privileged-system-context concepts from OpenCode's system-context
 * module (temp/ref-repos/opencode/CONTEXT.md) into idiomatic mission-control
 * TypeScript without the Effect dependency.
 *
 * Core concepts (CONTEXT.md language):
 * - **Context Source**: one independently observed typed value with a stable key,
 *   JSON codec, infallible loader, pure baseline/update renderers, and an
 *   optional removal renderer.
 * - **System Context Registry**: location-scoped registry of ordered Context
 *   Sources that contribute to the current System Context.
 * - **Context Epoch**: the span during which one effective agent's initially
 *   rendered Baseline System Context remains immutable, ending at compaction.
 * - **Baseline System Context**: the full System Context rendered at the start
 *   of a Context Epoch.
 * - **Mid-Conversation System Message**: a durable chronological instruction
 *   that tells the model the newly effective state of a changed Context Source.
 *
 * The registry is generic: domain modules (boulder-store, plan-store) register
 * their own sources into it. This module owns no domain imports.
 */
// allow: SIZE_OK — 192 pure-code LOC (280 awk-count includes ~88 lines of CONTEXT.md domain-concept docstrings); module is one cohesive algebra (codec + source + packed carrier + registry + epoch) that splits artificially across files.

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Stable namespaced identity for one independently refreshable context source. */
export type SystemContextKey = string;

/** JSON codec for a context source value: encode to comparable string, decode back. */
export interface SystemContextCodec<A> {
    readonly encode: (value: A) => string;
    readonly decode: (raw: string) => A | null;
    readonly equals: (left: A, right: A) => boolean;
}

/** Type-safe identity codec for simple string-valued context sources. */
export const stringContextCodec: SystemContextCodec<string> = {
    encode: (value) => value,
    decode: (raw) => raw,
    equals: (left, right) => left === right,
};

/** JSON codec for any JSON-serializable value compared by encoded string equality. */
export const jsonContextCodec: SystemContextCodec<unknown> = {
    encode: (value) => JSON.stringify(value),
    decode: (raw) => {
        try {
            return JSON.parse(raw) as unknown;
        } catch {
            return null;
        }
    },
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
};

// ---------------------------------------------------------------------------
// Source definition (typed, before packing)
// ---------------------------------------------------------------------------

/**
 * Defines one typed context source before its value type is erased by packing.
 *
 * - `loader` returns null to signal **Unavailable Context** (stale-while-revalidate).
 * - `baseline` renders the initial model-visible text for one value.
 * - `update` renders the delta text when the value changes; return null to skip.
 * - `removed` renders the removal text when the source leaves the registry.
 */
export interface SystemContextSource<A> {
    readonly key: string;
    readonly codec: SystemContextCodec<A>;
    readonly loader: () => Promise<A | null>;
    readonly baseline: (value: A) => string;
    readonly update: (previous: A, current: A) => string | null;
    readonly removed?: (previous: A) => string;
}

// ---------------------------------------------------------------------------
// Packed source (type-erased, composable)
// ---------------------------------------------------------------------------

/** Result of comparing an admitted snapshot against a freshly loaded value. */
export type SourceComparison =
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'changed'; readonly updateText: string; readonly encodedValue: string };

/** One loaded source observation with its baseline text and comparison closure. */
export interface LoadedSource {
    readonly baselineText: string;
    readonly encodedValue: string;
    readonly removalText: string | null;
    readonly compare: (previousEncoded: string) => SourceComparison;
}

/** A source with its value type erased so differently typed sources compose. */
export interface PackedSystemContextSource {
    readonly key: string;
    readonly load: () => Promise<LoadedSource | null>;
}

/** Observation of one registered source: loaded value or null (unavailable). */
export interface SourceObservation {
    readonly key: string;
    readonly loaded: LoadedSource | null;
}

/**
 * Closes a typed source into a packed carrier that composes uniformly with
 * sources built from other value types. Mirrors OpenCode's `SystemContext.make`.
 */
export function packSystemContextSource<A>(source: SystemContextSource<A>): PackedSystemContextSource {
    return {
        key: source.key,
        load: async () => {
            const value = await source.loader();
            if (value === null) {
                return null;
            }
            const encodedValue = source.codec.encode(value);
            const removalText = source.removed === undefined ? null : source.removed(value);
            return {
                baselineText: source.baseline(value),
                encodedValue,
                removalText,
                compare: (previousEncoded: string): SourceComparison => {
                    const previous = source.codec.decode(previousEncoded);
                    if (previous === null) {
                        return { kind: 'changed', updateText: source.baseline(value), encodedValue };
                    }
                    if (source.codec.equals(previous, value)) {
                        return { kind: 'unchanged' };
                    }
                    const updateText = source.update(previous, value);
                    if (updateText === null) {
                        return { kind: 'unchanged' };
                    }
                    return { kind: 'changed', updateText, encodedValue };
                },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Admitted snapshot (durable comparison state)
// ---------------------------------------------------------------------------

/** Durable comparison state for one admitted source within a Context Epoch. */
export interface AdmittedSnapshot {
    readonly encodedValue: string;
    readonly removalText: string | null;
}

/** Update batch result from `getUpdatesSince`. */
export interface ContextUpdateBatch {
    readonly updates: readonly string[];
    readonly newEpoch: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Location-scoped registry of Context Sources.
 *
 * Sources are registered as packed (type-erased) carriers. The registry
 * tracks a **Context Epoch** — a monotonic counter that advances each time
 * a change batch is admitted and resets to zero on compaction.
 *
 * Baseline rendering and update reconciliation both lazily observe source
 * loaders at call time (Safe Provider-Turn Boundary semantics); source changes
 * never push asynchronously.
 */
export class SystemContextRegistry {
    private readonly sources = new Map<string, PackedSystemContextSource>();
    private readonly admitted = new Map<string, AdmittedSnapshot>();
    private epoch = 0;

    /** Registers a packed source. Throws on duplicate key. */
    register(source: PackedSystemContextSource): void {
        if (this.sources.has(source.key)) {
            throw new SystemContextRegistryError('duplicate-key', `Duplicate system context key: ${source.key}`);
        }
        this.sources.set(source.key, source);
    }

    /** Looks up a source by key. Returns undefined for unknown or removed keys. */
    lookup(key: string): PackedSystemContextSource | undefined {
        return this.sources.get(key);
    }

    /** Lists all currently registered sources in insertion order. */
    list(): readonly PackedSystemContextSource[] {
        return [...this.sources.values()];
    }

    /**
     * Removes a source from the registry. The next `getUpdatesSince` call emits
     * the source's pre-rendered removal text (if it had a `removed` renderer).
     * Returns true if the source was present and removed.
     */
    remove(key: string): boolean {
        return this.sources.delete(key);
    }

    /** The current Context Epoch counter. */
    get currentEpoch(): number {
        return this.epoch;
    }

    /**
     * Renders the **Baseline System Context** — the full system context text
     * rendered at the start of a Context Epoch. Loads all registered sources
     * concurrently, stores their admitted snapshots, and returns the joined
     * baseline text. Sources that are unavailable (loader returns null) are
     * omitted from the baseline.
     */
    async getBaselineText(): Promise<string> {
        const observations = await this.observeAllSources();
        const parts: string[] = [];
        this.admitted.clear();
        for (const obs of observations) {
            if (obs.loaded === null) {
                continue;
            }
            parts.push(obs.loaded.baselineText);
            this.admitted.set(obs.key, {
                encodedValue: obs.loaded.encodedValue,
                removalText: obs.loaded.removalText,
            });
        }
        this.epoch = 0;
        return parts.join('\n\n');
    }

    /**
     * Reconciles current source values against the last-admitted snapshots and
     * returns any update texts. If at least one change is found, snapshots are
     * advanced and the epoch increments. Per CONTEXT.md, changes from multiple
     * sources at one safe boundary are returned as separate texts for the caller
     * to combine into one Mid-Conversation System Message.
     *
     * Unavailable sources (loader returns null) retain their prior snapshot
     * (stale-while-revalidate). Removed sources (no longer registered) emit
     * their pre-rendered removal text if they had a `removed` renderer.
     */
    async getUpdatesSince(_fromEpoch: number): Promise<ContextUpdateBatch> {
        const observations = await this.observeAllSources();
        const registeredKeys = new Set(observations.map((obs) => obs.key));
        const updates: string[] = [];
        const nextAdmitted = new Map<string, AdmittedSnapshot>();

        for (const obs of observations) {
            const previous = this.admitted.get(obs.key);
            if (obs.loaded === null) {
                if (previous !== undefined) {
                    nextAdmitted.set(obs.key, previous);
                }
                continue;
            }
            if (previous === undefined) {
                updates.push(obs.loaded.baselineText);
            } else {
                const comparison = obs.loaded.compare(previous.encodedValue);
                if (comparison.kind === 'unchanged') {
                    nextAdmitted.set(obs.key, previous);
                    continue;
                }
                updates.push(comparison.updateText);
            }
            nextAdmitted.set(obs.key, {
                encodedValue: obs.loaded.encodedValue,
                removalText: obs.loaded.removalText,
            });
        }

        for (const [key, snapshot] of this.admitted) {
            if (!registeredKeys.has(key) && snapshot.removalText !== null) {
                updates.push(snapshot.removalText);
            }
        }

        if (updates.length === 0) {
            return { updates: [], newEpoch: this.epoch };
        }

        this.admitted.clear();
        for (const [key, snapshot] of nextAdmitted) {
            this.admitted.set(key, snapshot);
        }
        this.epoch += 1;
        return { updates, newEpoch: this.epoch };
    }

    /**
     * Signals compaction — terminates the current Context Epoch, clears all
     * admitted snapshots, and resets the epoch counter to zero. The next
     * `getBaselineText` call establishes a fresh Baseline System Context.
     */
    compact(): void {
        this.admitted.clear();
        this.epoch = 0;
    }

    private async observeAllSources(): Promise<readonly SourceObservation[]> {
        const entries = [...this.sources.entries()];
        return Promise.all(
            entries.map(async ([key, source]) => ({
                key,
                loaded: await source.load(),
            })),
        );
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SystemContextRegistryErrorCode = 'duplicate-key';

export class SystemContextRegistryError extends Error {
    readonly code: SystemContextRegistryErrorCode;
    constructor(code: SystemContextRegistryErrorCode, message: string) {
        super(message);
        this.name = 'SystemContextRegistryError';
        this.code = code;
    }
}
