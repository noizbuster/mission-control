import { type SystemPromptSkill } from '../../../context/system-prompt';
import type { Blackboard } from '../../../memory/blackboard';
import { discoverSkills } from '../../../skills/skill-loader';
import { absolutePathMatchesDenylist, resolveUserConfigDir } from '../../../discovery/index';
import { walkResourceFiles } from '../../../discovery/resource-walker';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

type SkillManifest = Map<string, readonly [mtimeMs: number, size: number]>;
type SkillCacheEntry = { readonly skills: readonly SystemPromptSkill[]; readonly manifest: SkillManifest };

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


function resolveSkillScopeRoots(workspaceRoot: string): readonly string[] {
    const roots: string[] = [join(resolveUserConfigDir({}), 'skills')];
    if (!absolutePathMatchesDenylist(workspaceRoot)) {
        roots.push(join(workspaceRoot, '.mctrl', 'skills'));
        roots.push(join(workspaceRoot, '.agents', 'skills'));
    }
    return roots;
}

async function buildSkillManifest(workspaceRoot: string): Promise<SkillManifest> {
    const manifest: SkillManifest = new Map();
    for (const scopeRoot of resolveSkillScopeRoots(workspaceRoot)) {
        for (const filePath of await walkResourceFiles(scopeRoot, { matchesFile: (entry) => entry.isFile() && entry.name === 'SKILL.md' })) {
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
