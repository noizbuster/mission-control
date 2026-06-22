/**
 * Persistence for `.mctrl/agents.disabled` — a JSON set of agent names that
 * should be hidden from discovery. Used by the `mctrl agents disable/enable`
 * CLI subcommands and (future) the interactive `/agents disable` slash command.
 *
 * Format: `{ "disabled": ["name1", "name2"], "version": 1, ...unknownPassthrough }`.
 * Unknown fields survive read-modify-write round-trips. Writes are atomic
 * (temp-file-then-rename).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DISABLED_CONFIG_VERSION = 1;

type DisabledConfigShape = {
    readonly disabled?: unknown;
    readonly version?: unknown;
    readonly [key: string]: unknown;
};

export type DisabledConfigOptions = {
    readonly workspaceRoot: string;
    /** Override the config path (testing). Defaults to `<workspaceRoot>/.mctrl/agents.disabled`. */
    readonly disabledConfigPath?: string;
};

type DisabledDoc = {
    readonly disabled: readonly string[];
    readonly version: number;
    readonly extra: Record<string, unknown>;
};

const EMPTY_DOC: DisabledDoc = { disabled: [], version: DISABLED_CONFIG_VERSION, extra: {} };

export function resolveDisabledConfigPath(options: DisabledConfigOptions): string {
    return options.disabledConfigPath ?? join(options.workspaceRoot, '.mctrl', 'agents.disabled');
}

export async function readDisabledSet(options: DisabledConfigOptions): Promise<Set<string>> {
    const doc = await readDisabledDoc(options);
    return new Set(doc.disabled);
}

export type ToggleOutcome = {
    readonly alreadyDisabled: boolean;
    readonly alreadyEnabled: boolean;
};

export async function toggleDisabled(
    options: DisabledConfigOptions,
    name: string,
    action: 'add' | 'remove',
): Promise<ToggleOutcome> {
    const doc = await readDisabledDoc(options);
    const current = new Set(doc.disabled);
    if (action === 'add') {
        if (current.has(name)) return { alreadyDisabled: true, alreadyEnabled: false };
        current.add(name);
    } else {
        if (!current.has(name)) return { alreadyDisabled: false, alreadyEnabled: true };
        current.delete(name);
    }
    await writeDisabledDoc(options, { ...doc, disabled: [...current] });
    return { alreadyDisabled: false, alreadyEnabled: false };
}

async function readDisabledDoc(options: DisabledConfigOptions): Promise<DisabledDoc> {
    let raw: string;
    try {
        raw = await readFile(resolveDisabledConfigPath(options), 'utf8');
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
    const record = parsed as DisabledConfigShape;
    const disabledField = record.disabled;
    const disabledList = Array.isArray(disabledField)
        ? disabledField.filter((e): e is string => typeof e === 'string')
        : [];
    const version = typeof record.version === 'number' ? record.version : DISABLED_CONFIG_VERSION;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (key !== 'disabled' && key !== 'version') {
            extra[key] = value;
        }
    }
    return { disabled: disabledList, version, extra };
}

async function writeDisabledDoc(options: DisabledConfigOptions, doc: DisabledDoc): Promise<void> {
    const targetPath = resolveDisabledConfigPath(options);
    await mkdir(join(targetPath, '..'), { recursive: true });
    const payload: Record<string, unknown> = {
        ...doc.extra,
        disabled: [...doc.disabled],
        version: doc.version,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmpPath, serialized, 'utf8');
    await rename(tmpPath, targetPath);
}
