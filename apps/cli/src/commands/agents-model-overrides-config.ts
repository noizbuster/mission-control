/**
 * Persistence for `.mctrl/agents.model-overrides.json` — a JSON map of agent
 * name to a `provider/model[#variant]` string that overrides the model the
 * full-parity `task()` tool resolves for that named child agent.
 *
 * Used by the `mctrl agents` CLI subcommands (Todo 4/5) and wired into the
 * full-parity task tool factory closure (Todo 3) so a stored override changes
 * the spawned child's model. The override is INERT at spawn until the CLI
 * graph-runner connection (todo 25) lands; until then the closure-level wiring
 * is the accepted proof surface.
 *
 * Format: `{ "overrides": { "<name>": "<provider/model[#variant]>" }, "version": 1, ...unknownPassthrough }`.
 * Unknown fields survive read-modify-write round-trips. Writes are atomic
 * (temp-file-then-rename), mirroring {@linkcode ./agents-disabled-config.js}.
 * On missing, corrupt, or unparseable input the reader returns an empty map and
 * never throws.
 */

import { atomicWriteJsonFile, type ModelPattern } from '@mission-control/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const OVERRIDES_CONFIG_VERSION = 1;

type OverridesConfigShape = {
    readonly overrides?: unknown;
    readonly version?: unknown;
    readonly [key: string]: unknown;
};

export type OverridesConfigOptions = {
    readonly workspaceRoot: string;
    /** Override the config path (testing). Defaults to `<workspaceRoot>/.mctrl/agents.model-overrides.json`. */
    readonly overridesConfigPath?: string;
};

type OverridesDoc = {
    readonly overrides: ReadonlyMap<string, string>;
    readonly version: number;
    readonly extra: Record<string, unknown>;
};

const EMPTY_DOC: OverridesDoc = {
    overrides: new Map<string, string>(),
    version: OVERRIDES_CONFIG_VERSION,
    extra: {},
};

export function resolveOverridesConfigPath(options: OverridesConfigOptions): string {
    return options.overridesConfigPath ?? join(options.workspaceRoot, '.mctrl', 'agents.model-overrides.json');
}

/** Read the overrides as raw `provider/model[#variant]` strings keyed by agent name. */
export async function readOverridesMap(options: OverridesConfigOptions): Promise<Map<string, string>> {
    const doc = await readOverridesDoc(options);
    return new Map(doc.overrides);
}

export type SetOverrideOutcome = {
    readonly alreadySet: boolean;
};

/** Set `name -> value`, or clear `name` when `value` is undefined. */
export async function setOverride(
    options: OverridesConfigOptions,
    name: string,
    value: string | undefined,
): Promise<SetOverrideOutcome> {
    const doc = await readOverridesDoc(options);
    const current = new Map(doc.overrides);
    const alreadySet = current.get(name) === value;
    if (value === undefined) {
        current.delete(name);
    } else {
        current.set(name, value);
    }
    await writeOverridesDoc(options, { ...doc, overrides: current });
    return { alreadySet };
}

/** Remove the override for `name` (no-op when absent). */
export async function clearOverride(options: OverridesConfigOptions, name: string): Promise<void> {
    await setOverride(options, name, undefined);
}

async function readOverridesDoc(options: OverridesConfigOptions): Promise<OverridesDoc> {
    let raw: string;
    try {
        raw = await readFile(resolveOverridesConfigPath(options), 'utf8');
    } catch {
        return EMPTY_DOC;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return EMPTY_DOC;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return EMPTY_DOC;
    }
    const record = parsed as OverridesConfigShape;
    const overridesField = record.overrides;
    const overridesMap = new Map<string, string>();
    if (overridesField !== null && typeof overridesField === 'object' && !Array.isArray(overridesField)) {
        for (const [key, value] of Object.entries(overridesField as Record<string, unknown>)) {
            if (typeof value === 'string') overridesMap.set(key, value);
        }
    }
    const version = typeof record.version === 'number' ? record.version : OVERRIDES_CONFIG_VERSION;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (key !== 'overrides' && key !== 'version') {
            extra[key] = value;
        }
    }
    return { overrides: overridesMap, version, extra };
}

async function writeOverridesDoc(options: OverridesConfigOptions, doc: OverridesDoc): Promise<void> {
    const targetPath = resolveOverridesConfigPath(options);
    const overridesObject: Record<string, string> = {};
    for (const [name, value] of doc.overrides) {
        overridesObject[name] = value;
    }
    const payload: Record<string, unknown> = {
        ...doc.extra,
        overrides: overridesObject,
        version: doc.version,
    };
    await atomicWriteJsonFile(targetPath, payload);
}

/**
 * Parse a `provider/model[#variant]` string into a {@linkcode ModelPattern}.
 * Mirrors the CLI's `parseProviderModelShorthand` convention: the first `/`
 * splits provider from model; the last `#` splits an optional variant. Returns
 * `undefined` for any malformed shape (empty provider/model, dangling `#`).
 */
export function parseModelPatternString(raw: string): ModelPattern | undefined {
    const slashIndex = raw.indexOf('/');
    if (slashIndex <= 0 || slashIndex === raw.length - 1) {
        return undefined;
    }
    const providerID = raw.slice(0, slashIndex);
    const modelInput = raw.slice(slashIndex + 1);
    const variantSeparatorIndex = modelInput.lastIndexOf('#');
    if (variantSeparatorIndex < 0) {
        return { providerID, modelID: modelInput };
    }
    if (variantSeparatorIndex === 0 || variantSeparatorIndex === modelInput.length - 1) {
        return undefined;
    }
    return {
        providerID,
        modelID: modelInput.slice(0, variantSeparatorIndex),
        variantID: modelInput.slice(variantSeparatorIndex + 1),
    };
}

/**
 * Read overrides and parse each value into a {@linkcode ModelPattern}, dropping
 * any entry whose stored string is malformed. The returned map is ready to pass
 * straight into the full-parity task tool factory's `agentModelOverrides`.
 */
export async function readModelPatternOverrides(options: OverridesConfigOptions): Promise<Map<string, ModelPattern>> {
    const raw = await readOverridesMap(options);
    const parsed = new Map<string, ModelPattern>();
    for (const [name, value] of raw) {
        const pattern = parseModelPatternString(value);
        if (pattern !== undefined) parsed.set(name, pattern);
    }
    return parsed;
}
