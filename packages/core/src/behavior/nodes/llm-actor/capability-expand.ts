/**
 * OpenCode-style coarse→fine capability expansion for LLM-actor tool advertising.
 *
 * Workflow/graph nodes declare coarse capability labels (`read`, `write`, `bash`, …).
 * Tools register fine-grained `capabilityClasses` (`repo.read`, `file.edit`, `bash.run`, …).
 * Exact string match alone hides the basic tools; this table is the single mapping seam
 * (modeled on OpenCode `Permission.disabled`, which collapses `edit`/`write`/`apply_patch`
 * into one permission key before filtering the advertised tool set).
 *
 * Rules:
 * - Every declared label always includes itself (fine-grained node caps still work).
 * - Coarse labels expand to the tool classes they are meant to unlock.
 * - This filter is ADVERTISING only — approval/permission brokers still gate execution.
 */

/**
 * Expand map: node capability label → additional tool capabilityClasses accepted.
 * Keys not listed still match themselves only (via {@link expandCapabilityLabels}).
 */
export const CAPABILITY_EXPAND: Readonly<Record<string, readonly string[]>> = {
    // Coarse ABG / workflow vocabulary (default, planner, fixer, executer graphs).
    read: ['read', 'repo.read'],
    write: ['write', 'edit', 'file.edit', 'file.write', 'file.patch'],
    // OpenCode edit-class group: edit/write/apply_patch share permission "edit".
    edit: ['edit', 'write', 'file.edit', 'file.write', 'file.patch'],
    bash: ['bash', 'bash.run', 'command.run', 'exec'],
    exec: ['exec', 'bash.run', 'command.run', 'bash'],
    network: ['network'],
    subagent: ['subagent'],
    workflow: ['workflow'],
    team: ['team'],
    // Fine classes expand to themselves (no-op extras) so dual-tagged tools keep working.
    'repo.read': ['repo.read', 'read'],
    'file.edit': ['file.edit', 'edit', 'write'],
    'file.write': ['file.write', 'edit', 'write'],
    'file.patch': ['file.patch', 'edit', 'write'],
    'bash.run': ['bash.run', 'bash', 'exec'],
    'command.run': ['command.run', 'bash', 'exec'],
    // Stale coding-agent graph vocabulary still present in some fixtures.
    'filesystem.write': ['file.edit', 'file.write', 'file.patch', 'write', 'edit'],
    'filesystem.read': ['repo.read', 'read'],
};

/**
 * Expand a node capability list into the set of tool capabilityClasses that may be advertised.
 * Unknown labels are kept as-is so custom/plugin classes pass through without a table update.
 */
export function expandCapabilityLabels(capabilities: readonly string[]): ReadonlySet<string> {
    const expanded = new Set<string>();
    for (const label of capabilities) {
        expanded.add(label);
        const extras = CAPABILITY_EXPAND[label];
        if (extras === undefined) continue;
        for (const entry of extras) {
            expanded.add(entry);
        }
    }
    return expanded;
}
