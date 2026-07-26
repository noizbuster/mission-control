/**
 * Shared resource-discovery helpers extracted from the skill/manifest walkers so the same
 * denylist + traversal logic serves skills, resources, and any future manifest walker.
 *
 * Reconstructed from the in-progress refactor in
 * `behavior/nodes/llm-actor/llm-actor-skill-cache.ts` (the denylist matcher and the config
 * dir resolver moved out of the skill cache).
 */
export { resolveUserConfigDir } from '../skills/skill-loader';

import { defaultAutomatedDiscoveryDenylist, toPosixPath } from '../tools/read-tools-paths';

export { manifestDenylistDirNames } from './resource-walker';

const manifestDenylistNeedles: readonly string[] = defaultAutomatedDiscoveryDenylist.map((entry) =>
    entry.toLowerCase(),
);

export function absolutePathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return manifestDenylistNeedles.some((needle) =>
        needle.length === 0 ? false : posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`),
    );
}
