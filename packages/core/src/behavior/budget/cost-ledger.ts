/**
 * Cost ledger: maps LLM usage → cents, accumulates across a graph run, and surfaces the
 * `policy.budget.*` cost events (ABG §11.4, Phase 5/8 deferred item).
 *
 * The model selection (`AbgNodeModelOptions`) carries a `budgetCents` ceiling; each LLMActor
 * turn's `usage` is priced via a `PricingTable` and accumulated. When accumulation crosses the
 * ceiling the ledger emits `policy.budget.exceeded` (the graph can route that to an escalate /
 * abort node); a soft `warnAtCents` emits `policy.budget.warning`. `policy.budget.accumulated`
 * fires every turn for observability.
 *
 * PRICING IS OPERATOR-SUPPLIED. `DEFAULT_PRICING` is intentionally empty: list prices drift
 * and shipping stale numbers would silently mislead. Wire a `PricingTable` via
 * `AbgGraphRunnerInput.pricingTable`; with no entry for a model, cost stays 0 (the ceiling
 * mechanism still runs, but never trips on its own). This keeps the feature honest.
 *
 * Token usage is extracted DEFENSIVELY from the AI-SDK `usage` object (typed `unknown` at the
 * node boundary): `inputTokens` / `outputTokens` are the load-bearing fields; `reasoningTokens`
 * and `cachedInputTokens` are priced separately when a pricing entry declares them.
 */
import type { AbgNodeModelOptions } from '@mission-control/protocol';

export type TokenUsage = {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cachedInputTokens: number;
};

/**
 * Price a model in cents per MILLION tokens (the industry quoting unit).
 * `modelID` matches by exact string OR a `<family>-` prefix so a single entry can cover a
 * model family (e.g. `modelID: 'claude-sonnet-4-6'` prices `-20260610` variants too).
 */
export type PricingEntry = {
    readonly providerID: string;
    readonly modelID?: string;
    readonly inputCentsPerMillion: number;
    readonly outputCentsPerMillion: number;
    readonly reasoningCentsPerMillion?: number;
    readonly cacheReadCentsPerMillion?: number;
};

export type PricingTable = readonly PricingEntry[];

/** No prices by default — operators wire a table to avoid shipping stale list prices. */
export const DEFAULT_PRICING: PricingTable = [];

export type ModelSelection = Pick<AbgNodeModelOptions, 'providerID' | 'modelID'>;

/** Most-specific match wins: exact modelID > family-prefix modelID > provider-only. */
export function resolvePricing(table: PricingTable, selection: ModelSelection): PricingEntry | undefined {
    const exact = table.find(
        (entry) => entry.providerID === selection.providerID && entry.modelID === selection.modelID,
    );
    if (exact !== undefined) {
        return exact;
    }
    const prefix = table.find(
        (entry) =>
            entry.providerID === selection.providerID &&
            entry.modelID !== undefined &&
            selection.modelID.startsWith(`${entry.modelID}-`),
    );
    if (prefix !== undefined) {
        return prefix;
    }
    return table.find((entry) => entry.providerID === selection.providerID && entry.modelID === undefined);
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'] as const;

/** Defensive extraction from the AI-SDK `usage` object (typed `unknown` at the boundary). */
export function extractTokenUsage(usage: unknown): TokenUsage {
    if (usage === null || typeof usage !== 'object') {
        return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    }
    const record = usage as Record<string, unknown>;
    const read = (field: (typeof TOKEN_FIELDS)[number]): number => {
        const value = record[field];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
    };
    return {
        inputTokens: read('inputTokens'),
        outputTokens: read('outputTokens'),
        reasoningTokens: read('reasoningTokens'),
        cachedInputTokens: read('cachedInputTokens'),
    };
}

export type CostBreakdown = {
    readonly cents: number;
    readonly usage: TokenUsage;
};

/** Cents for one turn's usage at the given price (0 when no price). Integer cents, rounded. */
export function estimateCostCents(usage: TokenUsage, pricing: PricingEntry | undefined): number {
    if (pricing === undefined) {
        return 0;
    }
    const perMillion = (tokens: number, centsPerMillion: number): number => (tokens * centsPerMillion) / 1_000_000;
    let cents = perMillion(usage.inputTokens, pricing.inputCentsPerMillion);
    cents += perMillion(usage.outputTokens, pricing.outputCentsPerMillion);
    if (pricing.reasoningCentsPerMillion !== undefined) {
        cents += perMillion(usage.reasoningTokens, pricing.reasoningCentsPerMillion);
    }
    if (pricing.cacheReadCentsPerMillion !== undefined && usage.cachedInputTokens > 0) {
        // Cache reads are CHEAPER than full input — subtract the full-input charge for the
        // cached portion and add the cache-read charge instead.
        cents -= perMillion(usage.cachedInputTokens, pricing.inputCentsPerMillion);
        cents += perMillion(usage.cachedInputTokens, pricing.cacheReadCentsPerMillion);
    }
    return Math.max(0, Math.round(cents));
}

export type BudgetCostEvent = {
    readonly eventType: 'policy.budget.accumulated' | 'policy.budget.warning' | 'policy.budget.exceeded';
    readonly cents: number;
    readonly budgetCents?: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelCalls: number;
};

export type BudgetConfig = {
    /** Hard ceiling in cents. When total crosses this, `policy.budget.exceeded` fires. */
    readonly budgetCents?: number;
    /** Soft threshold in cents. Defaults to 80% of budgetCents when omitted. */
    readonly warnAtCents?: number;
};

export type CostLedgerTotals = {
    readonly cents: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelCalls: number;
};

/**
 * Per-run accumulator. Created once by the coordinator and shared across the loop's
 * re-entries via `AbgNodeRunContext.budgetLedger`. `accumulate` is the only mutator; it
 * returns the budget events to emit for THIS turn (idempotent-level: crossing `exceeded`/
 * `warning` fires once per threshold, not every turn after).
 */
export class CostLedger {
    private readonly pricing: PricingTable;
    private readonly config: BudgetConfig;
    private cents = 0;
    private inputTokens = 0;
    private outputTokens = 0;
    private modelCalls = 0;
    private warned = false;
    private exceeded = false;

    constructor(pricing: PricingTable, config: BudgetConfig = {}) {
        this.pricing = pricing;
        this.config = config;
    }

    totals(): CostLedgerTotals {
        return {
            cents: this.cents,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            modelCalls: this.modelCalls,
        };
    }

    /**
     * Add a turn's usage at the selection's price and return the budget events to emit this
     * turn. Always emits one `policy.budget.accumulated`; emits `warning`/`exceeded` the first
     * time the running total crosses each threshold.
     */
    accumulate(input: { readonly usage: unknown; readonly selection: ModelSelection }): readonly BudgetCostEvent[] {
        const usage = extractTokenUsage(input.usage);
        const pricing = resolvePricing(this.pricing, input.selection);
        const turnCents = estimateCostCents(usage, pricing);
        this.cents += turnCents;
        this.inputTokens += usage.inputTokens;
        this.outputTokens += usage.outputTokens;
        this.modelCalls += 1;

        const events: BudgetCostEvent[] = [
            {
                eventType: 'policy.budget.accumulated',
                cents: this.cents,
                ...(this.config.budgetCents !== undefined ? { budgetCents: this.config.budgetCents } : {}),
                inputTokens: this.inputTokens,
                outputTokens: this.outputTokens,
                modelCalls: this.modelCalls,
            },
        ];

        const warnAt = this.warnAtCents();
        if (warnAt !== undefined && !this.warned && this.cents >= warnAt) {
            this.warned = true;
            events.push(this.thresholdEvent('policy.budget.warning', warnAt));
        }
        if (this.config.budgetCents !== undefined && !this.exceeded && this.cents >= this.config.budgetCents) {
            this.exceeded = true;
            events.push(this.thresholdEvent('policy.budget.exceeded', this.config.budgetCents));
        }
        return events;
    }

    private warnAtCents(): number | undefined {
        if (this.config.warnAtCents !== undefined) {
            return this.config.warnAtCents;
        }
        if (this.config.budgetCents !== undefined) {
            return Math.floor(this.config.budgetCents * 0.8);
        }
        return undefined;
    }

    private thresholdEvent(
        eventType: 'policy.budget.warning' | 'policy.budget.exceeded',
        thresholdCents: number,
    ): BudgetCostEvent {
        return {
            eventType,
            cents: this.cents,
            budgetCents: thresholdCents,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            modelCalls: this.modelCalls,
        };
    }
}

/** Build a `CostLedger` for a run, or `undefined` when no budget and no pricing are configured. */
export function createCostLedger(input: {
    readonly pricingTable?: PricingTable;
    readonly budget?: BudgetConfig;
}): CostLedger | undefined {
    const hasBudget = input.budget?.budgetCents !== undefined || input.budget?.warnAtCents !== undefined;
    const hasPricing = (input.pricingTable?.length ?? 0) > 0;
    if (!hasBudget && !hasPricing) {
        return undefined;
    }
    return new CostLedger(input.pricingTable ?? DEFAULT_PRICING, input.budget ?? {});
}
