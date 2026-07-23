import { type SystemPromptSkill } from '../../../context/system-prompt';
import type { Blackboard } from '../../../memory/blackboard';
import { discoverSkills, resolveUserConfigDir } from '../../../skills/skill-loader';
import { defaultAutomatedDiscoveryDenylist, toPosixPath } from '../../../tools/read-tools-paths';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

type SkillManifest = Map<string, readonly [mtimeMs: number, size: number]>;
type SkillCacheEntry = { readonly skills: readonly SystemPromptSkill[]; readonly manifest: SkillManifest };

const MAX_MANIFEST_WALK_DEPTH = 10;
const manifestDenylistNeedles: readonly string[] = defaultAutomatedDiscoveryDenylist.map((entry) =>
    entry.toLowerCase(),
);
const manifestDenylistDirNames: ReadonlySet<string> = new Set(
    defaultAutomatedDiscoveryDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

let skillCache = new WeakMap<Blackboard, SkillCacheEntry>();

export function _testResetSkillCache(): void {
    skillCache = new WeakMap();
}

export function bustSkillCache(): void {
    skillCache = new WeakMap();
}

export async function discoverPromptSkills(
    workspaceRoot: string,
    blackboard: Blackboard | undefined,
): Promise<readonly SystemPromptSkill[]> {
    if (blackboard === undefined) return loadPromptSkillsUncached(workspaceRoot);
    const freshManifest = await buildSkillManifest(workspaceRoot);
    const cached = skillCache.get(blackboard);
    if (cached !== undefined && manifestsEqual(cached.manifest, freshManifest)) return cached.skills;
    const skills = await loadPromptSkillsUncached(workspaceRoot);
    skillCache.set(blackboard, { skills, manifest: freshManifest });
    return skills;
}

function pathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return manifestDenylistNeedles.some((needle) =>
        needle.length === 0 ? false : posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`),
    );
}

function resolveSkillScopeRoots(workspaceRoot: string): readonly string[] {
    const roots: string[] = [join(resolveUserConfigDir({}), 'skills')];
    if (!pathMatchesDenylist(workspaceRoot)) {
        roots.push(join(workspaceRoot, '.mctrl', 'skills'));
        roots.push(join(workspaceRoot, '.agents', 'skills'));
    }
    return roots;
}

async function walkSkillManifestFiles(scopeRoot: string): Promise<readonly string[]> {
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
            } else if (entry.isFile() && entry.name === 'SKILL.md') {
                results.push(fullPath);
            }
        }
    }
    return results.sort();
}

async function buildSkillManifest(workspaceRoot: string): Promise<SkillManifest> {
    const manifest: SkillManifest = new Map();
    for (const scopeRoot of resolveSkillScopeRoots(workspaceRoot)) {
        for (const filePath of await walkSkillManifestFiles(scopeRoot)) {
            try {
                const stats = await stat(filePath);
                manifest.set(filePath, [stats.mtimeMs, stats.size] as const);
            } catch {
                continue;
            }
        }
    }
    return manifest;
}

function manifestsEqual(left: SkillManifest, right: SkillManifest): boolean {
    if (left.size !== right.size) return false;
    for (const [path, [mtimeMs, size]] of left) {
        const entry = right.get(path);
        if (entry === undefined || entry[0] !== mtimeMs || entry[1] !== size) return false;
    }
    return true;
}

async function loadPromptSkillsUncached(workspaceRoot: string): Promise<readonly SystemPromptSkill[]> {
    try {
        const result = await discoverSkills({ workspaceRoot });
        return result.skills
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
                name: skill.name,
                description: skill.description,
                ...(skill.filePath.length > 0 ? { location: skill.filePath } : {}),
            }));
    } catch {
        return [];
    }
}
