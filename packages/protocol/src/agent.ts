import { z } from 'zod';
import { PolicyEffectRuleSchema } from './permission-rule.js';

/**
 * Where an {@linkcode AgentDefinition} was discovered. Mirrors the skill/workflow three-scope
 * discovery model (user config, project `.agents/`, plugin) plus a `bundled` value for agents
 * shipped with the runtime itself.
 */
export const AGENT_SOURCES = ['bundled', 'user', 'project', 'plugin'] as const;
export const AgentSourceSchema = z.enum(AGENT_SOURCES);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

/**
 * Approval weight an agent carries (Task A5). `read` agents only observe, `write` agents mutate
 * workspace state with approval, `exec` agents run commands and spawn children. Tier replaces the
 * older `permissions: PermissionKind[]` field; pair with {@linkcode AgentDefinitionSchema}'s
 * `pathPolicies` for fine-grained resource gates.
 */
export const AGENT_TIERS = ['read', 'write', 'exec'] as const;
export const AgentTierSchema = z.enum(AGENT_TIERS);
export type AgentTier = z.infer<typeof AgentTierSchema>;

/** Provider reasoning-effort presets forwarded to capable model adapters. */
export const AGENT_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const AgentThinkingLevelSchema = z.enum(AGENT_THINKING_LEVELS);
export type AgentThinkingLevel = z.infer<typeof AgentThinkingLevelSchema>;

/**
 * A deployable agent declaration: the system prompt, tool surface, spawn surface, model preset,
 * and policy gates an agent runs with. Discovered from bundled defaults, user config, project
 * `.agents/`, or plugins (see {@linkcode AgentSourceSchema}).
 *
 * Required: `name`, `description`, `systemPrompt`, `source`. Approval weighting uses `tier` +
 * `pathPolicies` (Task A5), not a `permissions` array. `recursion: -1` means unlimited nesting.
 */
export const AgentDefinitionSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().min(1),
        systemPrompt: z.string(),

        tools: z.array(z.string()).optional(),
        spawns: z.union([z.array(z.string()), z.literal('*')]).optional(),
        model: z
            .union([
                z.string(),
                z.object({ providerID: z.string(), modelID: z.string() }).strict(),
            ])
            .optional(),
        thinkingLevel: AgentThinkingLevelSchema.optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        blocking: z.boolean().optional(),
        autoloadSkills: z.array(z.string()).optional(),
        readSummarize: z.boolean().optional(),
        maxTurns: z.number().int().positive().optional(),
        recursion: z.union([z.literal(-1), z.number().int().min(0)]).optional(),
        role: z.string().optional(),
        tier: AgentTierSchema.optional(),
        color: z.string().optional(),
        pathPolicies: z.array(PolicyEffectRuleSchema).optional(),

        source: AgentSourceSchema,
        filePath: z.string().optional(),
        disabled: z.boolean().optional(),
    })
    .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** A list of agent declarations, indexed by name at runtime. */
export const AgentListSchema = z.array(AgentDefinitionSchema);
export type AgentList = z.infer<typeof AgentListSchema>;
