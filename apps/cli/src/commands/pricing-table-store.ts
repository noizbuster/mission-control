import { type PricingEntry, resolveMissionControlDataDir } from '@mission-control/core';
import { PricingTableSchema } from '@mission-control/protocol';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PRICING_TABLE_FILENAME = 'pricing-table.json';

export async function loadPricingTable(): Promise<readonly PricingEntry[]> {
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, PRICING_TABLE_FILENAME);
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const result = PricingTableSchema.safeParse(parsed);
        if (result.success) {
            return result.data.map((entry) => ({
                providerID: entry.providerID,
                ...(entry.modelID !== undefined ? { modelID: entry.modelID } : {}),
                inputCentsPerMillion: entry.inputCentsPerMillion,
                outputCentsPerMillion: entry.outputCentsPerMillion,
                ...(entry.reasoningCentsPerMillion !== undefined
                    ? { reasoningCentsPerMillion: entry.reasoningCentsPerMillion }
                    : {}),
                ...(entry.cacheReadCentsPerMillion !== undefined
                    ? { cacheReadCentsPerMillion: entry.cacheReadCentsPerMillion }
                    : {}),
            }));
        }
        return [];
    } catch {
        return [];
    }
}
