/**
 * Spawn policy for child-agent delegation.
 *
 * Determines whether a parent agent may spawn a named child agent based on
 * three checks evaluated in order (first denial wins):
 *
 *   1. Self-recursion: `parentId === childId` — prevents an agent from
 *      spawning itself when both identifiers are supplied.
 *   2. `MCTRL_BLOCKED_AGENT` env var — a global agent-name block set by the
 *      parent process before spawning children (mirrors oh-my-pi's
 *      `PI_BLOCKED_AGENT` recursion-prevention mechanism).
 *   3. The parent's `spawns` allowlist: `undefined`/`[]` denies all (safe
 *      default), `'*'` allows all, an array allows only the listed names.
 *
 * This module only evaluates policy; it does not perform the actual spawn
 * (that is `ConcreteTaskToolRuntime`'s responsibility).
 */
import type { AgentDefinition } from '@mission-control/protocol';

/** Environment variable holding the blocked agent name. Set by the parent process. */
export const BLOCKED_AGENT_ENV_KEY = 'MCTRL_BLOCKED_AGENT';

/**
 * Resolves the parent's spawn allowlist.
 *
 * - `undefined` or `[]` → `[]` (deny all — safe default)
 * - `'*'` → `'*'` (allow all)
 * - `string[]` → the array as-is (specific allowlist)
 */
export function resolveParentSpawns(parent: AgentDefinition): string[] | '*' {
    return parent.spawns ?? [];
}

export interface CanSpawnOptions {
    /** Unique identifier of the parent agent instance. */
    readonly parentId?: string;
    /** Unique identifier of the child agent instance. */
    readonly childId?: string;
}

export interface SpawnDecision {
    readonly allowed: boolean;
    readonly reason: string;
}

function readBlockedAgent(): string | undefined {
    const value = process.env[BLOCKED_AGENT_ENV_KEY];
    return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Decides whether `parent` may spawn a child agent named `childAgentName`.
 *
 * Evaluation order (first denial wins):
 *   1. Self-recursion: both `parentId` and `childId` are provided and equal.
 *   2. `MCTRL_BLOCKED_AGENT` env var matches `childAgentName`.
 *   3. Parent's `spawns` allowlist (deny-all / wildcard / explicit list).
 */
export function canSpawn(parent: AgentDefinition, childAgentName: string, opts?: CanSpawnOptions): SpawnDecision {
    if (opts?.parentId !== undefined && opts?.childId !== undefined && opts.parentId === opts.childId) {
        return { allowed: false, reason: 'self-recursion blocked (parent and child are the same instance)' };
    }

    const blockedAgent = readBlockedAgent();
    if (blockedAgent !== undefined && childAgentName === blockedAgent) {
        return {
            allowed: false,
            reason: `blocked by MCTRL_BLOCKED_AGENT ('${blockedAgent}' is globally blocked)`,
        };
    }

    const spawns = resolveParentSpawns(parent);
    if (spawns === '*') {
        return { allowed: true, reason: "parent allows all spawns ('*')" };
    }
    if (spawns.includes(childAgentName)) {
        return {
            allowed: true,
            reason: `child '${childAgentName}' is in parent spawns allowlist`,
        };
    }
    return {
        allowed: false,
        reason: `parent spawns do not include '${childAgentName}' (allowed: ${
            spawns.length === 0 ? 'none — deny all' : spawns.join(', ')
        })`,
    };
}
