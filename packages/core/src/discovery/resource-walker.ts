/**
 * Shared bounded directory walker for resource discovery (skills, etc.).
 *
 * Reconstructed from the in-progress refactor in
 * `behavior/nodes/llm-actor/llm-actor-skill-cache.ts` (`walkSkillManifestFiles` generalized
 * with a caller-supplied file matcher).
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultAutomatedDiscoveryDenylist } from '../tools/read-tools-paths';

const MAX_MANIFEST_WALK_DEPTH = 10;
const manifestDenylistDirNames: ReadonlySet<string> = new Set(
    defaultAutomatedDiscoveryDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

export type WalkResourceFilesOptions = {
    readonly matchesFile: (entry: Dirent) => boolean;
};

export async function walkResourceFiles(
    scopeRoot: string,
    options: WalkResourceFilesOptions,
): Promise<readonly string[]> {
    const results: string[] = [];
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: scopeRoot, depth: 0 }];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined || item.depth > MAX_MANIFEST_WALK_DEPTH) continue;
        let entries: readonly Dirent[];
        try {
            entries = await readdir(item.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const fullPath = join(item.dir, entry.name);
            if (entry.isDirectory()) {
                if (!manifestDenylistDirNames.has(entry.name.toLowerCase())) {
                    queue.push({ dir: fullPath, depth: item.depth + 1 });
                }
            } else if (entry.isFile() && options.matchesFile(entry)) {
                results.push(fullPath);
            }
        }
    }
    return results.sort();
}
