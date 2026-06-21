import { z } from 'zod';

export const PricingEntrySchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().optional(),
    inputCentsPerMillion: z.number().nonnegative(),
    outputCentsPerMillion: z.number().nonnegative(),
    reasoningCentsPerMillion: z.number().nonnegative().optional(),
    cacheReadCentsPerMillion: z.number().nonnegative().optional(),
});
export type PricingEntry = z.infer<typeof PricingEntrySchema>;

export const PricingTableSchema = z.array(PricingEntrySchema);
export type PricingTable = z.infer<typeof PricingTableSchema>;

export const BudgetConfigSchema = z.object({
    budgetCents: z.number().nonnegative().optional(),
    warnAtCents: z.number().nonnegative().optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
