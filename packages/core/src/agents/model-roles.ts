/**
 * Built-in model roles, mirroring oh-my-pi's 10-role set verbatim.
 *
 * `MODEL_ROLES` carries display metadata for each role. `parseModelAlias` and
 * `formatModelAlias` convert between the `mctrl/<role>` alias form and the
 * typed `ModelRole`. `LEGACY_CATEGORY_MODEL_ALIASES` maps the old
 * category-catalog aliases (`opus`, `sonnet`) onto the new role set for
 * backward compatibility during the Wave 6 migration.
 */

export type ModelRole =
    | 'default'
    | 'smol'
    | 'slow'
    | 'vision'
    | 'plan'
    | 'designer'
    | 'commit'
    | 'title'
    | 'task'
    | 'advisor';

export interface ModelRoleInfo {
    readonly tag: string;
    readonly name: string;
    readonly color: string;
    /** Functional role hidden from the model selector UI. */
    readonly hidden?: boolean;
}

export const MODEL_ROLES: Readonly<Record<ModelRole, ModelRoleInfo>> = {
    default: { tag: 'DEFAULT', name: 'Default', color: 'success' },
    smol: { tag: 'SMOL', name: 'Fast', color: 'warning' },
    slow: { tag: 'SLOW', name: 'Thinking', color: 'accent' },
    vision: { tag: 'VISION', name: 'Vision', color: 'error' },
    plan: { tag: 'PLAN', name: 'Architect', color: 'muted' },
    designer: { tag: 'DESIGNER', name: 'Designer', color: 'muted' },
    commit: { tag: 'COMMIT', name: 'Commit', color: 'dim' },
    title: { tag: 'TITLE', name: 'Title', color: 'dim', hidden: true },
    task: { tag: 'TASK', name: 'Subtask', color: 'muted' },
    advisor: { tag: 'ADVISOR', name: 'Advisor', color: 'accent' },
};

export const MODEL_ROLE_IDS: readonly ModelRole[] = [
    'default',
    'smol',
    'slow',
    'vision',
    'plan',
    'designer',
    'commit',
    'title',
    'task',
    'advisor',
];

export const MODEL_ROLE_ALIAS_PREFIX = 'mctrl/';

function isModelRole(value: string): value is ModelRole {
    return value in MODEL_ROLES;
}

export function parseModelAlias(input: string): ModelRole | undefined {
    if (!input.startsWith(MODEL_ROLE_ALIAS_PREFIX)) return undefined;
    const candidate = input.slice(MODEL_ROLE_ALIAS_PREFIX.length);
    return isModelRole(candidate) ? candidate : undefined;
}

export function formatModelAlias(role: ModelRole): string {
    return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export const LEGACY_CATEGORY_MODEL_ALIASES: Readonly<Record<'opus' | 'sonnet', ModelRole>> = {
    opus: 'slow',
    sonnet: 'default',
};
