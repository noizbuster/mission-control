/**
 * Pure bridge between persisted model role assignments and the agent model
 * resolver's {@linkcode ModelPattern} shape.
 *
 * The storage layer (`ProviderAuthStore` / `auth.json`) persists role
 * assignments as {@linkcode ModelProviderSelection} values (a protocol type).
 * The agent model resolver in `@mission-control/core` consumes a
 * `Partial<Record<ModelRole, ModelPattern>>`. The two shapes are structurally
 * identical but live on opposite sides of the package boundary (protocol vs
 * core), so the conversion is done once here instead of inlined at every
 * consumer. TODO #3 (resolver wiring) and the ChatStore plumbing consume this
 * module.
 *
 * `modelRolesToRoleConfig` is fully synchronous and side-effect-free;
 * `buildRoleConfigFromAuth` is the async convenience that reads from the auth
 * store and delegates to the synchronous converter.
 */

import type { ModelPattern, ProviderAuthStore } from '@mission-control/core';
import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';

/**
 * Convert persisted role assignments into the resolver's role-config shape.
 *
 * Each {@linkcode ModelProviderSelection} is mapped to a {@linkcode ModelPattern}
 * of the same fields. Entries whose value is `undefined` are dropped. The
 * optional `variantID` is spread conditionally so the converted object never
 * carries an explicit `variantID: undefined` (required under
 * `exactOptionalPropertyTypes`).
 */
export function modelRolesToRoleConfig(
    roles: Partial<Record<ModelRole, ModelProviderSelection>>,
): Partial<Record<ModelRole, ModelPattern>> {
    const result: Partial<Record<ModelRole, ModelPattern>> = {};
    for (const [role, selection] of Object.entries(roles)) {
        if (selection === undefined) continue;
        result[role as ModelRole] = {
            providerID: selection.providerID,
            modelID: selection.modelID,
            ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        };
    }
    return result;
}

/**
 * Read persisted role assignments from the auth store and convert them into
 * the resolver's role-config shape. Returns `{}` when the store has no role
 * assignments (mirrors `getModelRoles()` which returns `{}` for an empty
 * store).
 */
export async function buildRoleConfigFromAuth(
    authStore: ProviderAuthStore,
): Promise<Partial<Record<ModelRole, ModelPattern>>> {
    const roles = await authStore.getModelRoles();
    return modelRolesToRoleConfig(roles);
}
