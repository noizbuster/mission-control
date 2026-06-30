import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type VariantOverrideEntry = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
};

export type VariantOverrides = Readonly<Record<string, readonly VariantOverrideEntry[]>>;

const VARIANT_OVERRIDE_PATHS: readonly string[] = [
    join(process.cwd(), '.mctrl', 'model-variants.json'),
    join(
        process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
        'mission-control',
        'model-variants.json',
    ),
];

let cached: VariantOverrides | undefined;

export function loadVariantOverrides(): VariantOverrides {
    if (cached !== undefined) return cached;
    const merged: Record<string, readonly VariantOverrideEntry[]> = {};
    for (const path of VARIANT_OVERRIDE_PATHS) {
        const parsed = tryReadOverrideFile(path);
        if (parsed === undefined) continue;
        for (const [key, ids] of Object.entries(parsed)) {
            if (key in merged) continue;
            if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) continue;
            merged[key] = ids.map((id) => ({
                id,
                name: variantDisplayNameFromID(id),
                status: 'active' as const,
            }));
        }
    }
    cached = merged;
    return merged;
}

function tryReadOverrideFile(path: string): Record<string, unknown> | undefined {
    try {
        const text = readFileSync(path, 'utf8');
        const value: unknown = JSON.parse(text);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function variantDisplayNameFromID(id: string): string {
    const match = /^(reasoning|thinking)-(.+)$/.exec(id);
    if (match !== null) {
        const prefix = match[1];
        const value = match[2];
        if (prefix !== undefined && value !== undefined) {
            const kind = prefix === 'thinking' ? 'Thinking' : 'Reasoning';
            const level = value.charAt(0).toUpperCase() + value.slice(1);
            return `${kind} ${level}`;
        }
    }
    return id;
}
