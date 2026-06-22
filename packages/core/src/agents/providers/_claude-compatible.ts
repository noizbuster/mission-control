/**
 * Shared Claude-compatible frontmatter conversion. Used by the Claude Code
 * provider (todo 9) and the Cursor provider (todo 10). Both harnesses use
 * markdown + YAML frontmatter with Claude-specific fields (effort, skills,
 * disallowedTools, hooks, mcpServers, ...) that must be mapped or stripped
 * before {@linkcode parseAgentFile}'s strict AgentDefinitionSchema validation
 * can pass.
 *
 * The conversion pipeline for each file is:
 *   1. Split frontmatter + body (same `---` fence logic as parseAgentFile).
 *   2. Parse YAML, call {@linkcode convertClaudeFrontmatter} to map/rename/drop.
 *   3. Rebuild markdown from the converted fields + original body.
 *   4. Feed rebuilt content to {@linkcode parseAgentFile} for full validation.
 *   5. Surface `unsupported_field` diagnostics for dropped Claude-only fields.
 */
import { AGENT_THINKING_LEVELS, type AgentDefinition, type AgentThinkingLevel } from '@mission-control/protocol';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentDiscoveryDiagnostic } from '../agent-loader.js';
import { AgentParseError, parseAgentFile } from '../agent-parser.js';
import type { LoadContext } from '../capability/types.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const CLAUDE_TOOL_NAME_MAP: Record<string, string> = {
    Read: 'read',
    ls: 'ls',
    Grep: 'grep',
    Glob: 'glob',
    find: 'find',
    Edit: 'file.edit',
    Write: 'file.write',
    NotebookEdit: 'file.edit',
    Bash: 'command.run',
    bash: 'bash.run',
    WebFetch: 'webfetch',
    WebSearch: 'webfetch',
    TodoWrite: 'todowrite',
    Task: 'task',
    Skill: 'skill',
    Agent: 'task',
};

const FRONTMATTER_DELIMITER = '---';
const AGENT_FILE_SUFFIX = '.md';
const EXCLUDED_FILE_NAME = 'agents.md';
const MAX_FILE_BYTES = 64 * 1024;

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(AGENT_THINKING_LEVELS);

export interface ClaudeFrontmatterConversion {
    readonly agent: Partial<AgentDefinition>;
    readonly unsupportedFields: readonly string[];
}

/**
 * Convert raw Claude-format frontmatter into a {@linkcode Partial}<AgentDefinition>
 * plus a list of field names that were present but not supported.
 *
 * Mapping summary:
 * - `effort: string` → `thinkingLevel` (validated against AGENT_THINKING_LEVELS).
 * - `tools: string` (CSV) or `string[]` → mapped through CLAUDE_TOOL_NAME_MAP.
 * - `skills: string[]` → `autoloadSkills`.
 * - `name`, `description`, `model`, `maxTurns`, `color` → passthrough.
 * - Everything else (including `disallowedTools`, `hooks`, `mcpServers`,
 *   `permissionMode`, `initialPrompt`, `memory`, `background`, `isolation`)
 *   is collected in `unsupportedFields`.
 */
export function convertClaudeFrontmatter(
    raw: Record<string, unknown>,
    _sourceDir: string,
): ClaudeFrontmatterConversion {
    const unsupportedFields: string[] = [];
    const agent: Partial<AgentDefinition> = {};

    for (const [key, value] of Object.entries(raw)) {
        if (key === 'name') {
            if (typeof value === 'string') agent.name = value;
            continue;
        }
        if (key === 'description') {
            if (typeof value === 'string') agent.description = value;
            continue;
        }
        if (key === 'model') {
            if (typeof value === 'string') agent.model = value;
            continue;
        }
        if (key === 'maxTurns') {
            if (typeof value === 'number') agent.maxTurns = value;
            continue;
        }
        if (key === 'color') {
            if (typeof value === 'string') agent.color = value;
            continue;
        }
        if (key === 'effort') {
            if (typeof value === 'string' && isThinkingLevel(value)) {
                agent.thinkingLevel = value;
            } else {
                unsupportedFields.push('effort');
            }
            continue;
        }
        if (key === 'skills') {
            if (isStringArray(value)) {
                agent.autoloadSkills = value;
            } else {
                unsupportedFields.push('skills');
            }
            continue;
        }
        if (key === 'tools') {
            const mapped = mapClaudeTools(value);
            if (mapped.length > 0) agent.tools = mapped;
            continue;
        }
        unsupportedFields.push(key);
    }

    return { agent, unsupportedFields };
}

function mapClaudeTools(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];

    let entries: string[];
    if (typeof raw === 'string') {
        entries = raw
            .split(',')
            .map((e) => e.trim())
            .filter((e) => e.length > 0);
    } else if (Array.isArray(raw)) {
        entries = raw
            .filter((e): e is string => typeof e === 'string')
            .map((e) => e.trim())
            .filter((e) => e.length > 0);
    } else {
        return [];
    }

    return entries.map((entry) => CLAUDE_TOOL_NAME_MAP[entry] ?? entry);
}

function isThinkingLevel(value: string): value is AgentThinkingLevel {
    return VALID_THINKING_LEVELS.has(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((e) => typeof e === 'string');
}

export interface ClaudeLoadResult {
    readonly agents: readonly AgentDefinition[];
    readonly diagnostics: readonly AgentDiscoveryDiagnostic[];
}

/**
 * Scan `dirs` for `*.md` files, convert each through
 * {@linkcode convertClaudeFrontmatter}, validate via
 * {@linkcode parseAgentFile}, and return agents + diagnostics.
 *
 * Missing directories yield empty arrays (never throws). Per-file read or
 * parse failures produce `parse_error` diagnostics and are skipped. The
 * `providerId` is embedded in diagnostic messages so callers can identify
 * which provider produced each diagnostic.
 */
export async function loadClaudeCompatibleAgents(
    _ctx: LoadContext,
    dirs: readonly string[],
    providerId: string,
): Promise<ClaudeLoadResult> {
    const agents: AgentDefinition[] = [];
    const diagnostics: AgentDiscoveryDiagnostic[] = [];

    for (const dir of dirs) {
        for (const filePath of await listMarkdownFiles(dir)) {
            const outcome = await tryLoadAndConvert(filePath, providerId);
            if (outcome.agent !== undefined) {
                agents.push(outcome.agent);
            }
            diagnostics.push(...outcome.diagnostics);
        }
    }

    return { agents, diagnostics };
}

async function listMarkdownFiles(dir: string): Promise<readonly string[]> {
    let entries: readonly Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const files: string[] = [];
    for (const entry of sorted) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(AGENT_FILE_SUFFIX)) continue;
        if (entry.name.toLowerCase() === EXCLUDED_FILE_NAME) continue;
        files.push(join(dir, entry.name));
    }
    return files;
}

type LoadOutcome = {
    readonly agent: AgentDefinition | undefined;
    readonly diagnostics: readonly AgentDiscoveryDiagnostic[];
};

function parseOrDiagnose(
    filePath: string,
    content: string,
    agentName: string,
    providerId: string,
): { readonly agent: AgentDefinition | undefined; readonly error: AgentDiscoveryDiagnostic | undefined } {
    try {
        return { agent: parseAgentFile(filePath, content, 'plugin'), error: undefined };
    } catch (err: unknown) {
        const msg = err instanceof AgentParseError ? err.message : `parse failed: ${instanceMessage(err)}`;
        return {
            agent: undefined,
            error: {
                agentName,
                severity: 'error',
                code: 'parse_error',
                message: `[${providerId}] ${msg}`,
                path: filePath,
            },
        };
    }
}

function parseFallback(filePath: string, content: string, agentName: string, providerId: string): LoadOutcome {
    const { agent, error } = parseOrDiagnose(filePath, content, agentName, providerId);
    return { agent, diagnostics: error !== undefined ? [error] : [] };
}

async function tryLoadAndConvert(filePath: string, providerId: string): Promise<LoadOutcome> {
    const agentName = deriveAgentName(filePath);

    let content: string;
    try {
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_BYTES) return { agent: undefined, diagnostics: [] };
        content = await readFile(filePath, 'utf8');
    } catch {
        return { agent: undefined, diagnostics: [] };
    }

    const split = splitFrontmatter(content);
    if (split === null) return parseFallback(filePath, content, agentName, providerId);

    let raw: Record<string, unknown>;
    try {
        const parsed = parseYaml(split.frontmatterText);
        if (!isStringRecord(parsed)) return parseFallback(filePath, content, agentName, providerId);
        raw = parsed;
    } catch {
        return parseFallback(filePath, content, agentName, providerId);
    }

    const { agent: converted, unsupportedFields } = convertClaudeFrontmatter(raw, filePath);
    const diagnostics: AgentDiscoveryDiagnostic[] = unsupportedFields.map((field) => ({
        agentName,
        severity: 'info',
        code: 'unsupported_field',
        message: `[${providerId}] field '${field}' is not supported and was ignored`,
        path: filePath,
    }));

    const rebuilt = rebuildMarkdown(converted, split.body);
    const { agent, error } = parseOrDiagnose(filePath, rebuilt, agentName, providerId);
    if (error !== undefined) diagnostics.push(error);
    return { agent, diagnostics };
}

interface FrontmatterSplit {
    readonly frontmatterText: string;
    readonly body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit | null {
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const lines = text.split(/\r?\n/);
    const firstLine = lines[0];
    if (firstLine === undefined || firstLine.trim() !== FRONTMATTER_DELIMITER) {
        return null;
    }

    let closeIdx = -1;
    for (let i = 1; i < lines.length; i += 1) {
        const candidate = lines[i];
        if (candidate !== undefined && candidate.trim() === FRONTMATTER_DELIMITER) {
            closeIdx = i;
            break;
        }
    }
    if (closeIdx === -1) return null;

    return {
        frontmatterText: lines.slice(1, closeIdx).join('\n'),
        body: lines
            .slice(closeIdx + 1)
            .join('\n')
            .trim(),
    };
}

function rebuildMarkdown(agent: Partial<AgentDefinition>, body: string): string {
    const yamlText = stringifyYaml(agent).trim();
    return `${FRONTMATTER_DELIMITER}\n${yamlText}\n${FRONTMATTER_DELIMITER}\n${body}`;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deriveAgentName(filePath: string): string {
    const base = basename(filePath).replace(/\.md$/u, '');
    return base.length > 0 ? base : basename(filePath);
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
