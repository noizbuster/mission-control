import { describe, expect, it } from 'vitest';
import {
    type BudgetConfig,
    CostLedger,
    createCostLedger,
    DEFAULT_PRICING,
    estimateCostCents,
    extractTokenUsage,
    type PricingTable,
    resolvePricing,
} from './cost-ledger.js';

const pricing: PricingTable = [
    // $3 / $15 per million tokens = 300 / 1500 cents.
    { providerID: 'anthropic', modelID: 'claude-sonnet-4-6', inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
    // provider-only fallback: $1 / $2 per million.
    { providerID: 'openai', inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
    // reasoning model: $2 input / $6 output / $10 reasoning / $0.50 cache read.
    {
        providerID: 'openai',
        modelID: 'o-reasoning',
        inputCentsPerMillion: 200,
        outputCentsPerMillion: 600,
        reasoningCentsPerMillion: 1000,
        cacheReadCentsPerMillion: 50,
    },
];

describe('extractTokenUsage', () => {
    it('reads the AI-SDK usage fields defensively', () => {
        expect(extractTokenUsage({ inputTokens: 1000, outputTokens: 400 })).toEqual({
            inputTokens: 1000,
            outputTokens: 400,
            reasoningTokens: 0,
            cachedInputTokens: 0,
        });
        expect(
            extractTokenUsage({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cachedInputTokens: 2 }),
        ).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 3,
            cachedInputTokens: 2,
        });
    });

    it('returns zeros for malformed usage', () => {
        expect(extractTokenUsage(null)).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
        });
        expect(extractTokenUsage('nope')).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
        });
        expect(extractTokenUsage({ inputTokens: 'x', outputTokens: -1 })).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
        });
    });
});

describe('resolvePricing', () => {
    it('prefers an exact modelID match', () => {
        expect(
            resolvePricing(pricing, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' })?.inputCentsPerMillion,
        ).toBe(300);
    });

    it('falls back to a provider-only entry', () => {
        // 'gpt-4o' has no modelID entry under openai → provider-only $1/$2.
        expect(resolvePricing(pricing, { providerID: 'openai', modelID: 'gpt-4o' })?.inputCentsPerMillion).toBe(100);
    });

    it('returns undefined for an unknown provider', () => {
        expect(resolvePricing(pricing, { providerID: 'nope', modelID: 'x' })).toBeUndefined();
    });

    it('matches a model family by prefix', () => {
        expect(
            resolvePricing(pricing, { providerID: 'openai', modelID: 'o-reasoning-2026-01' })?.reasoningCentsPerMillion,
        ).toBe(1000);
    });
});

describe('estimateCostCents', () => {
    it('prices input + output at per-million rates', () => {
        // 1M input @ 300 + 0.5M output @ 1500 = 300 + 750 = 1050 cents.
        const usage = extractTokenUsage({ inputTokens: 1_000_000, outputTokens: 500_000 });
        expect(
            estimateCostCents(
                usage,
                resolvePricing(pricing, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }),
            ),
        ).toBe(1050);
    });

    it('returns 0 when no pricing is resolved', () => {
        expect(estimateCostCents(extractTokenUsage({ inputTokens: 999, outputTokens: 999 }), undefined)).toBe(0);
    });

    it('prices reasoning tokens and discounts cache reads', () => {
        // 1M input (incl 0.2M cached) + 0 reasoning cache logic:
        // base input 1M @ 200 = 200; cache read subtracts 0.2M @ 200 = 40, adds 0.2M @ 50 = 10 → input net 170.
        const usage = extractTokenUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 200_000 });
        const entry = resolvePricing(pricing, { providerID: 'openai', modelID: 'o-reasoning' });
        expect(estimateCostCents(usage, entry)).toBe(170);
    });
});

describe('CostLedger', () => {
    const budget: BudgetConfig = { budgetCents: 1000 };

    it('accumulates cents + tokens across turns', () => {
        const ledger = new CostLedger(pricing, budget);
        ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(ledger.totals()).toEqual({ cents: 600, inputTokens: 2_000_000, outputTokens: 0, modelCalls: 2 });
    });

    it('emits accumulated every turn and warning/exceeded once each at their thresholds', () => {
        const ledger = new CostLedger(pricing, { budgetCents: 1000, warnAtCents: 400 });
        // turn 1: 1M input @ 300 = 300 cents (no warning yet).
        const t1 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t1.map((e) => e.eventType)).toEqual(['policy.budget.accumulated']);
        // turn 2: +300 = 600 → crosses warnAt 400 → warning fires.
        const t2 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t2.map((e) => e.eventType)).toEqual(['policy.budget.accumulated', 'policy.budget.warning']);
        // turn 3: +300 = 900 (still under 1000).
        const t3 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t3.map((e) => e.eventType)).toEqual(['policy.budget.accumulated']);
        // turn 4: +300 = 1200 → exceeds 1000.
        const t4 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t4.map((e) => e.eventType)).toEqual(['policy.budget.accumulated', 'policy.budget.exceeded']);
        // turn 5: thresholds do not re-fire.
        const t5 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t5.map((e) => e.eventType)).toEqual(['policy.budget.accumulated']);
    });

    it('defaults warnAtCents to 80% of budgetCents', () => {
        const ledger = new CostLedger(pricing, { budgetCents: 1000 });
        // 80% of 1000 = 800. First turn 300, second 600, third 900 → warning at turn 3.
        ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        const t3 = ledger.accumulate({
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(t3.some((e) => e.eventType === 'policy.budget.warning')).toBe(true);
    });

    it('stays at 0 cents with the empty DEFAULT_PRICING (no pricing configured)', () => {
        const ledger = new CostLedger(DEFAULT_PRICING, { budgetCents: 1000 });
        ledger.accumulate({
            usage: { inputTokens: 5_000_000, outputTokens: 5_000_000 },
            selection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        });
        expect(ledger.totals().cents).toBe(0);
    });
});

describe('createCostLedger', () => {
    it('returns undefined when neither budget nor pricing is configured', () => {
        expect(createCostLedger({})).toBeUndefined();
        expect(createCostLedger({ pricingTable: [] })).toBeUndefined();
    });

    it('creates a ledger when a budget ceiling is set (even without pricing)', () => {
        const ledger = createCostLedger({ budget: { budgetCents: 50 } });
        expect(ledger).toBeInstanceOf(CostLedger);
    });

    it('creates a ledger when pricing is configured (even without a ceiling)', () => {
        const ledger = createCostLedger({ pricingTable: pricing });
        expect(ledger).toBeInstanceOf(CostLedger);
    });
});
