import { type PermissionRule, PermissionRuleSchema } from '@mission-control/protocol';
import { isNodeError } from '../util/node-error';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { normalizePermissionRules, normalizePermissionWorkspaceRoot } from './workspace-root';
import { atomicWriteFile } from '../persistence/atomic-write';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const permissionRuleFileSchema = z
    .object({
        version: z.literal(1),
        rules: z.array(PermissionRuleSchema),
    })
    .strict();

type PermissionRuleFile = z.infer<typeof permissionRuleFileSchema>;

const emptyRuleFile = { version: 1, rules: [] } satisfies PermissionRuleFile;

export type PermissionRuleStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
};

export type PermissionRuleAppendOptions = {
    readonly beforeCommit?: () => void;
};

export class PermissionRuleStore {
    readonly filePath: string;

    constructor(options: PermissionRuleStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'trust', 'permission-rules.json');
    }

    async listRules(workspaceRoot: string): Promise<readonly PermissionRule[]> {
        const file = await readRuleFile(this.filePath);
        const normalizedWorkspaceRoot = await normalizePermissionWorkspaceRoot(workspaceRoot);
        const normalizedRules = await normalizePermissionRules(filterPersistedRules(file.rules));
        return normalizedRules.filter((rule) => rule.workspaceRoot === normalizedWorkspaceRoot);
    }

    async appendRules(rules: readonly PermissionRule[], options: PermissionRuleAppendOptions = {}): Promise<void> {
        if (rules.length === 0) {
            return;
        }
        const existing = await readRuleFile(this.filePath);
        const mergedRules = dedupeRules([
            ...(await normalizePermissionRules(filterPersistedRules(existing.rules))),
            ...(await normalizePermissionRules(rules)),
        ]);
        await writeRuleFile(this.filePath, { version: 1, rules: [...mergedRules] }, options);
    }
}

async function readRuleFile(filePath: string): Promise<PermissionRuleFile> {
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            return emptyRuleFile;
        }
        throw error;
    }
    return permissionRuleFileSchema.parse(JSON.parse(contents));
}

async function writeRuleFile(
    filePath: string,
    file: PermissionRuleFile,
    options: PermissionRuleAppendOptions,
): Promise<void> {
    await atomicWriteFile(filePath, `${JSON.stringify(file, null, 2)}\n`, {
        ...(options.beforeCommit !== undefined ? { beforeCommit: options.beforeCommit } : {}),
    });
}

function dedupeRules(rules: readonly PermissionRule[]): readonly PermissionRule[] {
    const entries = new Map<string, PermissionRule>();
    for (const rule of rules) {
        const key = `${rule.workspaceRoot ?? ''}:${rule.permission}:${rule.pattern}:${rule.decision}`;
        entries.set(key, rule);
    }
    return [...entries.values()].sort(compareRules);
}

function filterPersistedRules(rules: readonly PermissionRule[]): readonly PermissionRule[] {
    return rules.filter((rule) => rule.workspaceRoot !== undefined && isAbsolute(rule.workspaceRoot));
}

function compareRules(left: PermissionRule, right: PermissionRule): number {
    const leftKey = `${left.workspaceRoot ?? ''}:${left.permission}:${left.pattern}:${left.decision}`;
    const rightKey = `${right.workspaceRoot ?? ''}:${right.permission}:${right.pattern}:${right.decision}`;
    return leftKey.localeCompare(rightKey);
}


