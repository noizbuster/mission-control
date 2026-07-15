/**
 * Per-agent model resolution with one task-inheritance special case and four
 * normal precedence tiers.
 *
 * Resolution order (highest to lowest):
 *   1. `agentModelOverride` (or compatible `settingsOverride`) — named override for this agent
 *   2. `agent.model` — the agent's own frontmatter field, resolved through
 *      `mctrl/<role>` aliases, legacy category aliases, or a concrete object
 *   3. `parentActiveModel` — the model of the parent agent that spawned this one
 *   4. `sessionDefault` — the session's baseline model
 *
 * Exact `mctrl/task` is a special case evaluated before those tiers: it
 * inherits the parent active model, or the session default when no parent is
 * active. Named and role overrides cannot replace that inheritance. Legacy
 * aliases (`opus`, `sonnet`) map onto the new role set via
 * {@linkcode LEGACY_CATEGORY_MODEL_ALIASES}.
 *
 * No provider/model values are hardcoded — every concrete `ModelPattern` comes
 * from the caller's `roleConfig` or input.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { ModelRole } from './model-roles';
import { LEGACY_CATEGORY_MODEL_ALIASES, parseModelAlias } from './model-roles';

export interface ModelPattern {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
}

export interface ResolveAgentModelInput {
    readonly agent: AgentDefinition;
    readonly parentActiveModel?: ModelPattern;
    readonly sessionDefault: ModelPattern;
    readonly agentModelOverride?: ModelPattern;
    readonly settingsOverride?: ModelPattern;
    readonly roleConfig: Partial<Record<ModelRole, ModelPattern>>;
}

type AgentModelSelection =
    | { readonly kind: 'inherit' }
    | { readonly kind: 'task-inherit' }
    | { readonly kind: 'role'; readonly role: ModelRole }
    | { readonly kind: 'concrete'; readonly model: ModelPattern };

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

function classifyAgentModel(model: AgentDefinition['model']): AgentModelSelection {
    if (model === undefined) return { kind: 'inherit' };
    if (typeof model !== 'string') {
        return { kind: 'concrete', model: { providerID: model.providerID, modelID: model.modelID } };
    }
    const parsedRole = parseModelAlias(model);
    if (parsedRole === 'task') return { kind: 'task-inherit' };
    if (parsedRole !== undefined) return { kind: 'role', role: parsedRole };
    const legacyRole = resolveLegacyAlias(model);
    return legacyRole === undefined ? { kind: 'inherit' } : { kind: 'role', role: legacyRole };
}

export function resolveAgentModel(input: ResolveAgentModelInput): ModelPattern {
    const inherited = input.parentActiveModel ?? input.sessionDefault;
    const agentModelOverride = input.agentModelOverride ?? input.settingsOverride;
    const selection = classifyAgentModel(input.agent.model);
    switch (selection.kind) {
        case 'task-inherit':
            return inherited;
        case 'concrete':
            return agentModelOverride ?? selection.model;
        case 'role':
            return agentModelOverride ?? input.roleConfig[selection.role] ?? inherited;
        case 'inherit':
            return agentModelOverride ?? inherited;
        default:
            return assertNever(selection);
    }
}

function assertNever(selection: never): never {
    throw new TypeError(`Unhandled agent model selection: ${JSON.stringify(selection)}`);
}
