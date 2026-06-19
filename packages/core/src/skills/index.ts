/**
 * Skills subsystem public surface: SKILL.md discovery, frontmatter parsing, and
 * the metadata schema. Re-exported from the package root (packages/core/src/index.ts).
 *
 * Scope (todo 8): pure data loading — discovery + parsing. The `skill` tool,
 * `<available_skills>` system-prompt block, and `/skill-name` slash expansion
 * are owned by todos 9 and 10.
 */

export {
    DEFAULT_MAX_SKILL_FILE_BYTES,
    DEFAULT_MAX_SKILLS,
    type DiscoverSkillsOptions,
    type DiscoverSkillsResult,
    discoverSkills,
    type FrontmatterParseOutcome,
    type ParsedSkillFile,
    parseSkillFrontmatter,
    resolveUserConfigDir,
    type Skill,
    type SkillDiscoveryDiagnostic,
    type SkillScope,
    type SkillScopeId,
    type SkillSourceInfo,
    skillsConfigDirEnvKey,
} from './skill-loader.js';
export {
    SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_NAME_MAX_LENGTH,
    type SkillMetadata,
    SkillMetadataSchema,
    validateSkillMetadata,
} from './skill-metadata.js';
