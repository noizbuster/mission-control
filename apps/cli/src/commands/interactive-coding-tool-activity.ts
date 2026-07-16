import { redactCredentialText } from '@mission-control/core';
import type { ToolCall } from '@mission-control/protocol';

const MAX_ARG_CHARS = 96;
const MAX_RESULT_CHARS = 160;
const MAX_RESULT_LINES = 4;

export function formatToolCallActivity(toolCall: ToolCall): string {
    const args = formatToolArgsSummary(toolCall.toolName, toolCall.argumentsJson);
    return args.length > 0 ? `tool: ${toolCall.toolName} ${args}` : `tool: ${toolCall.toolName}`;
}

export function formatToolResultActivity(
    toolName: string,
    status: 'completed' | 'failed',
    options: {
        readonly modelOutput?: string;
        readonly structuredOutput?: unknown;
        readonly errorMessage?: string;
    } = {},
): string {
    if (status === 'failed') {
        const reason = options.errorMessage ?? 'unknown error';
        return `${toolName} failed: ${truncateInline(redact(reason))}`;
    }

    const specialized = formatSpecializedSuccess(toolName, options.structuredOutput, options.modelOutput);
    if (specialized !== undefined) {
        return specialized;
    }

    const body = summarizeModelOutput(options.modelOutput);
    return body.length > 0 ? `✓ ${toolName}: ${body}` : `✓ ${toolName}`;
}

export function formatToolArgsSummary(toolName: string, argumentsJson: string): string {
    const parsed = tryParseJson(argumentsJson);
    if (!isRecord(parsed)) {
        return truncateInline(redact(argumentsJson));
    }

    switch (toolName) {
        case 'glob':
        case 'find':
            return pickString(parsed, 'pattern') ?? pickString(parsed, 'glob') ?? pickString(parsed, 'path') ?? '';
        case 'grep':
        case 'repo.search':
            return joinParts([
                pickString(parsed, 'pattern') ?? pickString(parsed, 'query'),
                pickString(parsed, 'path') ?? pickString(parsed, 'include'),
            ]);
        case 'read':
        case 'repo.read':
        case 'ls':
        case 'repo.list':
            return pickString(parsed, 'path') ?? pickString(parsed, 'target') ?? '';
        case 'file.edit':
        case 'file.write':
            return pickString(parsed, 'path') ?? '';
        case 'file.patch':
            return 'patch';
        case 'command.run': {
            const command = pickString(parsed, 'command');
            const rawArgs = parsed['args'];
            const args = Array.isArray(rawArgs)
                ? rawArgs.filter((entry): entry is string => typeof entry === 'string').map((entry) => redact(entry))
                : [];
            return command === undefined ? '' : truncateInline(`$ ${[command, ...args].join(' ')}`);
        }
        case 'bash.run':
            return pickString(parsed, 'commandLine') ?? '';
        case 'task':
            return joinParts([pickString(parsed, 'agent'), pickString(parsed, 'assignment')]);
        case 'skill':
            return pickString(parsed, 'name') ?? '';
        case 'workflow':
            return joinParts([pickString(parsed, 'name'), pickString(parsed, 'prompt')]);
        case 'webfetch':
            return pickString(parsed, 'url') ?? '';
        case 'ast_grep':
        case 'ast-grep':
            return joinParts([
                pickString(parsed, 'pattern'),
                pickString(parsed, 'lang') ?? pickString(parsed, 'language'),
            ]);
        case 'generate_object':
            return 'structured';
        default:
            return truncateInline(redact(compactRecord(parsed)));
    }
}

function formatSpecializedSuccess(
    toolName: string,
    structured: unknown,
    modelOutput: string | undefined,
): string | undefined {
    if (isRecord(structured)) {
        const kind = structured['kind'];
        const appliedFilesRaw = structured['appliedFiles'];
        if (kind === 'file_patch' && Array.isArray(appliedFilesRaw)) {
            const files = appliedFilesRaw.filter((entry): entry is string => typeof entry === 'string');
            if (files.length > 0) return `Applied patch: ${files.join(', ')}`;
        }
        if (kind === 'file_edit' && Array.isArray(appliedFilesRaw)) {
            const files = appliedFilesRaw.filter((entry): entry is string => typeof entry === 'string');
            const nRaw = structured['occurrencesReplaced'];
            const n = typeof nRaw === 'number' ? nRaw : undefined;
            const noun = n === 1 ? 'occurrence' : 'occurrences';
            if (files.length > 0) {
                return n === undefined
                    ? `Applied edit: ${files.join(', ')}`
                    : `Applied edit: ${files.join(', ')} (${n} ${noun})`;
            }
        }
        if (kind === 'file_write' && Array.isArray(appliedFilesRaw)) {
            const files = appliedFilesRaw.filter((entry): entry is string => typeof entry === 'string');
            const verb = structured['operation'] === 'created' ? 'Created' : 'Replaced';
            if (files.length > 0) return `${verb} file: ${files.join(', ')}`;
        }
        const matches = structured['matches'];
        if (Array.isArray(matches)) {
            return `✓ ${toolName}: ${matches.length} match(es)`;
        }
        const files = structured['files'];
        if (Array.isArray(files)) {
            return `✓ ${toolName}: ${files.length} file(s)`;
        }
        const count = structured['count'];
        if (typeof count === 'number') {
            return `✓ ${toolName}: ${count}`;
        }
    }

    if (toolName === 'command.run' || toolName === 'bash.run') {
        const body = summarizeModelOutput(modelOutput);
        return body.length > 0 ? `Command output for ${toolName}: ${body}` : `✓ ${toolName}`;
    }

    return undefined;
}

function summarizeModelOutput(modelOutput: string | undefined): string {
    if (modelOutput === undefined) return '';
    const redacted = redact(modelOutput);
    const lines = redacted
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return '';
    if (lines.length === 1) return truncateInline(lines[0] ?? '');
    const head = lines.slice(0, MAX_RESULT_LINES).join(' · ');
    const more = lines.length > MAX_RESULT_LINES ? ` · +${lines.length - MAX_RESULT_LINES} lines` : '';
    return truncateInline(`${head}${more}`);
}

function compactRecord(value: Record<string, unknown>): string {
    const preferred = ['path', 'pattern', 'query', 'name', 'url', 'command', 'commandLine', 'prompt', 'agent'];
    for (const key of preferred) {
        const entry = value[key];
        if (typeof entry === 'string' && entry.length > 0) return entry;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function joinParts(parts: readonly (string | undefined)[]): string {
    return parts.filter((part): part is string => part !== undefined && part.length > 0).join(' ');
}

function pickString(value: Record<string, unknown>, key: string): string | undefined {
    const entry = value[key];
    return typeof entry === 'string' && entry.length > 0 ? truncateInline(redact(entry)) : undefined;
}

function redact(text: string): string {
    return redactCredentialText(text, []);
}

function truncateInline(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim();
    if (single.length <= MAX_ARG_CHARS) return single;
    return `${single.slice(0, MAX_RESULT_CHARS - 1)}…`;
}

function tryParseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
