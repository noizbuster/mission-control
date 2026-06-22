/**
 * Markdown + YAML frontmatter parser for agent definition files.
 *
 * Mirrors the discovery-safe parsing shape of {@linkcode ../skills/skill-loader.js}:
 * BOM-strip, `---` fence split, `yaml` package parse, schema-validate. The body
 * after the closing fence becomes the agent `systemPrompt`. The `tools` field
 * accepts three on-disk formats (CSV string, array, object map of enabled
 * tools) and is normalized to `string[]` before validation.
 *
 * Malformed input (missing fences, invalid YAML, empty frontmatter/body,
 * schema-invalid output) raises {@linkcode AgentParseError}. The function never
 * returns a partial or defaulted agent; callers receive a fully validated
 * {@linkcode AgentDefinition} or an exception.
 */
import { type AgentDefinition, AgentDefinitionSchema, type AgentSource } from '@mission-control/protocol';
import { parse as parseYaml } from 'yaml';

const FRONTMATTER_DELIMITER = '---';

/**
 * Error raised when an agent file cannot be parsed or fails schema validation.
 * `code` is always `'parse_failed'`; `cause` carries the originating Zod error
 * (or the YAML parse error) when available.
 */
export class AgentParseError extends Error {
    readonly code: 'parse_failed' = 'parse_failed';
    readonly filePath: string;
    override readonly cause: unknown;

    constructor(message: string, filePath: string, cause?: unknown) {
        super(message);
        this.name = 'AgentParseError';
        this.filePath = filePath;
        this.cause = cause;
    }
}

/**
 * Parse a markdown agent file (YAML frontmatter + markdown body) into a
 * validated {@linkcode AgentDefinition}.
 *
 * The caller supplies the `source` (where the file was discovered) and the
 * absolute `filePath`; both are stamped onto the output regardless of any
 * frontmatter-declared `source`/`filePath`/`systemPrompt` keys. The body
 * becomes `systemPrompt` after trimming surrounding whitespace.
 *
 * `tools` normalization covers three on-disk dialects:
 * - CSV string (`"read, search, find"`) → split, trim, drop empties.
 * - Array (`["read", "search"]`) → filtered to string entries.
 * - Object map (`{ "/": false, "search": true }`) → keys whose value is `true`.
 * - Absent → `undefined` (no tool restriction).
 */
export function parseAgentFile(filePath: string, content: string, source: AgentSource): AgentDefinition {
    const text = stripBom(content);
    const lines = text.split(/\r?\n/);
    const firstLine = lines[0];
    if (firstLine === undefined || firstLine.trim() !== FRONTMATTER_DELIMITER) {
        throw new AgentParseError('missing YAML frontmatter opening fence (---)', filePath);
    }

    let closeIdx = -1;
    for (let i = 1; i < lines.length; i += 1) {
        const candidate = lines[i];
        if (candidate !== undefined && candidate.trim() === FRONTMATTER_DELIMITER) {
            closeIdx = i;
            break;
        }
    }
    if (closeIdx === -1) {
        throw new AgentParseError('missing YAML frontmatter closing fence (---)', filePath);
    }

    const yamlText = lines.slice(1, closeIdx).join('\n');
    const body = lines
        .slice(closeIdx + 1)
        .join('\n')
        .trim();

    if (yamlText.trim().length === 0) {
        throw new AgentParseError('frontmatter has no fields', filePath);
    }
    if (body.length === 0) {
        throw new AgentParseError('agent body (system prompt) is empty', filePath);
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(yamlText);
    } catch (error: unknown) {
        throw new AgentParseError(`YAML parse failed: ${instanceMessage(error)}`, filePath, error);
    }

    if (!isStringRecord(parsed)) {
        throw new AgentParseError('frontmatter must be a YAML mapping (object), not a scalar or sequence', filePath);
    }

    // Detach `tools` for normalization; the rest passes through to the schema.
    const frontmatter: Record<string, unknown> = { ...parsed };
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
    const rawTools: unknown = frontmatter['tools'];
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
    delete frontmatter['tools'];
    const normalizedTools = normalizeTools(rawTools);

    const merged: Record<string, unknown> = {
        ...frontmatter,
        ...(normalizedTools !== undefined ? { tools: normalizedTools } : {}),
        systemPrompt: body,
        source,
        filePath,
    };

    const result = AgentDefinitionSchema.safeParse(merged);
    if (!result.success) {
        const detail = result.error.issues
            .map((issue) => {
                const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
                return `${path}: ${issue.message}`;
            })
            .join('; ');
        throw new AgentParseError(`agent schema validation failed: ${detail}`, filePath, result.error);
    }
    return result.data;
}

function normalizeTools(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string') {
        return raw
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    if (Array.isArray(raw)) {
        return raw.filter((entry): entry is string => typeof entry === 'string');
    }
    if (typeof raw === 'object') {
        return Object.entries(raw)
            .filter(([, value]) => value === true)
            .map(([key]) => key);
    }
    return undefined;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripBom(value: string): string {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
