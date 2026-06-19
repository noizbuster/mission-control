/**
 * Builds the per-turn system-prompt inputs the coding-agent graph needs so the model
 * knows WHERE it is operating and what project-local instructions (AGENTS.md/CLAUDE.md)
 * apply. Without these the model gets only a persona + tool list and tends to answer
 * generically instead of acting on the workspace.
 *
 * The helper is split into two functions because the inputs have different lifecycles:
 *  - `buildCodingAgentSystemPromptEnv` is pure (process/cwd state) and cheap; safe to
 *    call per turn.
 *  - `loadTrustedProjectInstructionResources` does file IO bounded to 64KB total and
 *    respects the project trust store; safe to call per turn (matches the flat path's
 *    per-turn `prependProjectContextMessages` precedent) but could be cached upstream.
 */
import {
    type ProjectInstructionResource,
    type ProjectResource,
    loadProjectResources,
    ProjectTrustStore,
    type SystemPromptEnvironment,
} from '@mission-control/core';
import { isGitWorkspace } from './git-workspace.js';

export type BuildSystemPromptEnvInput = {
    readonly workspaceRoot: string;
    readonly modelId?: string;
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string;
    readonly now?: () => Date;
};

/**
 * Build the `SystemPromptEnvironment` the LLMActor includes in the system prompt.
 * Defaults are taken from `process` so callers only override for tests.
 */
export async function buildCodingAgentSystemPromptEnv(
    input: BuildSystemPromptEnvInput,
): Promise<SystemPromptEnvironment> {
    const cwd = input.cwd ?? process.cwd();
    const platform = input.platform ?? process.platform;
    const date = (input.now ?? (() => new Date()))().toISOString();
    const gitEnabled = await isGitWorkspace(input.workspaceRoot);
    return {
        cwd,
        workspaceRoot: input.workspaceRoot,
        gitEnabled,
        platform,
        date,
        ...(input.modelId !== undefined && input.modelId.length > 0 ? { modelId: input.modelId } : {}),
    };
}

/**
 * Load trusted project instruction resources (AGENTS.md / CLAUDE.md) for the workspace.
 * Returns `[]` when the workspace is not trusted or no instruction files are present —
 * the caller threads the empty array unchanged. Resources are bounded to 64KB total by
 * `loadProjectResources`; truncation is preserved as `{ truncated: true }` but the
 * `truncated` flag is dropped from the system-prompt shape (`ProjectInstructionResource`
 * carries only `{ path, content }`).
 */
export async function loadTrustedProjectInstructionResources(
    workspaceRoot: string,
    trustStore: ProjectTrustStore = new ProjectTrustStore(),
): Promise<readonly ProjectInstructionResource[]> {
    const result = await loadProjectResources({
        workspaceRoot,
        trustStore,
    });
    if (result.status !== 'loaded') {
        return [];
    }
    return result.resources.map(projectResourceToInstructionResource);
}

function projectResourceToInstructionResource(resource: ProjectResource): ProjectInstructionResource {
    return { path: resource.path, content: resource.content };
}
