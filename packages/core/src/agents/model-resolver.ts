/**
 * Per-agent model resolution with 4-tier precedence.
 *
 * Resolution order (highest to lowest):
 *   1. `settingsOverride` — caller-injected override (e.g. CLI flag, session setting)
 *   2. `agent.model` — the agent's own frontmatter field, resolved through
 *      `mctrl/<role>` aliases, legacy category aliases, or a concrete object
 *   3. `parentActiveModel` — the model of the parent agent that spawned this one
 *   4. `sessionDefault` — the session's baseline model
 *
 * `mctrl/task` is a special case: the `task` role always inherits the session
 * default, regardless of `roleConfig.task`. Legacy aliases (`opus`, `sonnet`)
 * map onto the new role set via {@linkcode LEGACY_CATEGORY_MODEL_ALIASES}.
 *
 * No provider/model values are hardcoded — every concrete `ModelPattern` comes
 * from the caller's `roleConfig` or input.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { ModelRole } from './model-roles.js';
import { LEGACY_CATEGORY_MODEL_ALIASES, parseModelAlias } from './model-roles.js';

export interface ModelPattern {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
}

export interface ResolveAgentModelInput {
    readonly agent: AgentDefinition;
    readonly parentActiveModel?: ModelPattern;
    readonly sessionDefault: ModelPattern;
    readonly settingsOverride?: ModelPattern;
    readonly roleConfig: Partial<Record<ModelRole, ModelPattern>>;
}

/**
 * Empty role configuration. All roles are undefined by default; callers must
 * populate `roleConfig` with concrete {@linkcode ModelPattern} values before
 * alias resolution can return a role-bound model.
 */
export const DEFAULT_ROLE_CONFIG: Partial<Record<ModelRole, ModelPattern>> = {};

function resolveLegacyAlias(model: string): ModelRole | undefined {
    switch (model) {
        case 'opus':
            return LEGACY_CATEGORY_MODEL_ALIASES.opus;
        case 'sonnet':
            return LEGACY_CATEGORY_MODEL_ALIASES.sonnet;
        default:
            return undefined;
    }
}

/**
 * Resolve the `agent.model` field alone. Returns `undefined` when the field is
 * absent, when an alias resolves to a role not present in `roleConfig`, or when
 * the string is unrecognized — in all those cases the caller falls through to
 * the next precedence tier.
 */
function resolveAgentModelField(input: ResolveAgentModelInput): ModelPattern | undefined {
    const { agent, roleConfig, sessionDefault } = input;

    if (agent.model === undefined) return undefined;

    if (typeof agent.model === 'string') {
        const parsedRole = parseModelAlias(agent.model);

        if (parsedRole === 'task') return sessionDefault;

        if (parsedRole !== undefined) return roleConfig[parsedRole];

        const legacyRole = resolveLegacyAlias(agent.model);
        if (legacyRole !== undefined) return roleConfig[legacyRole];

        return undefined;
    }

    return { providerID: agent.model.providerID, modelID: agent.model.modelID };
}

export function resolveAgentModel(input: ResolveAgentModelInput): ModelPattern {
    if (input.settingsOverride !== undefined) return input.settingsOverride;

    const fromAgent = resolveAgentModelField(input);
    if (fromAgent !== undefined) return fromAgent;

    if (input.parentActiveModel !== undefined) return input.parentActiveModel;

    return input.sessionDefault;
}
