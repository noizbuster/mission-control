import type { NativeSummaryResult } from '../native/natives-client';
import { computeLineHash } from './hashline/hash-computation';
import { repoToolFailure } from './read-tools-errors';
import { createWorkspaceGuard, isBinarySample, type WorkspaceGuard } from './read-tools-paths';
import {
    type ListInput,
    type ListOutput,
    listInputSchema,
    listOutputSchema,
    listParametersJsonSchema,
    type ReadInput,
    type ReadOnlyRepoToolOptions,
    type ReadOutput,
    type ResolvedReadOnlyRepoToolOptions,
    readInputSchema,
    readModelOutput,
    readOutputSchema,
    readParametersJsonSchema,
    resolveOptions,
    type SearchInput,
    type SearchOutput,
    searchInputSchema,
    searchModelOutput,
    searchOutputSchema,
    searchParametersJsonSchema,
} from './read-tools-schemas';
import { searchRepoText } from './read-tools-search';
import { interceptRead } from './scheme-resolver';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type { ReadOnlyRepoToolOptions } from './read-tools-schemas';

type ReadOnlyRepoToolRegistrations = readonly [
    ToolRegistration<ReadInput, ReadOutput>,
    ToolRegistration<ListInput, ListOutput>,
    ToolRegistration<SearchInput, SearchOutput>,
    ToolRegistration<ReadInput, ReadOutput>,
    ToolRegistration<ListInput, ListOutput>,
    ToolRegistration<SearchInput, SearchOutput>,
    ToolRegistration<SearchInput, SearchOutput>,
    ToolRegistration<ReadInput, ReadOutput>,
];

export async function registerReadOnlyRepoTools(
    registry: ToolRegistry,
    options: ReadOnlyRepoToolOptions,
): Promise<readonly ToolAdvertisement[]> {
    const registrations = await createReadOnlyRepoToolRegistrations(options);
    return [
        registry.register(registrations[0]),
        registry.register(registrations[1]),
        registry.register(registrations[2]),
        registry.register(registrations[3]),
        registry.register(registrations[4]),
        registry.register(registrations[5]),
        registry.register(registrations[6]),
        registry.register(registrations[7]),
    ];
}

export async function createReadOnlyRepoToolRegistrations(
    options: ReadOnlyRepoToolOptions,
): Promise<ReadOnlyRepoToolRegistrations> {
    const resolved = resolveOptions(options);
    const guard = await createWorkspaceGuard(options.workspaceRoot, {
        allowDenylistedPaths: resolved.allowDenylistedPaths,
    });
    const registrations: ReadOnlyRepoToolRegistrations = [
        createReadTool(guard, resolved),
        createListTool(guard, resolved),
        createSearchTool(guard, resolved),
        createReadAliasTool(guard, resolved),
        createListAliasTool(guard, resolved),
        createSearchAliasTool(guard, resolved, 'grep', 'Search text files inside the workspace.'),
        createSearchAliasTool(guard, resolved, 'find', 'Find matching text inside workspace files.'),
        createReadTaggedTool(guard, resolved),
    ];
    return registrations;
}

function createReadTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<ReadInput, ReadOutput> {
    return {
        name: 'repo.read',
        description: 'Read a text file inside the workspace.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: readParametersJsonSchema(),
        inputSchema: readInputSchema,
        outputSchema: readOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: (input, context) => readWorkspaceFile(guard, options, input, context.toolName, context.toolCallId),
        toModelOutput: readModelOutput,
    };
}

function createListTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<ListInput, ListOutput> {
    return {
        name: 'repo.list',
        description: 'List directory entries inside the workspace.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: listParametersJsonSchema(),
        inputSchema: listInputSchema,
        outputSchema: listOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: (input, context) =>
            listWorkspaceDirectory(guard, options, input, context.toolName, context.toolCallId),
        toModelOutput: (output) =>
            output.entries.map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join('\n'),
    };
}

function createSearchTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<SearchInput, SearchOutput> {
    return {
        name: 'repo.search',
        description: 'Search text files inside the workspace.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: searchParametersJsonSchema(),
        inputSchema: searchInputSchema,
        outputSchema: searchOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: async (input, context) => {
            await requireReadPermission(options, context.toolCallId, context.toolName, [
                input.path ?? '.',
                input.include ?? '.',
            ]);
            const result = await searchRepoText(
                guard,
                searchInputForExecution(input),
                {
                    maxMatches: options.maxSearchMatches,
                    maxLineChars: options.maxSearchLineChars,
                },
                options.natives,
            );
            return {
                kind: 'search',
                pattern: input.pattern,
                path: input.path ?? '.',
                matches: [...result.matches],
                truncated: result.totalMatches > result.matches.length,
                totalMatches: result.totalMatches,
            };
        },
        toModelOutput: searchModelOutput,
    };
}

function createReadAliasTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<ReadInput, ReadOutput> {
    return {
        name: 'read',
        description: 'Read a text file inside the workspace.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: readParametersJsonSchema(),
        inputSchema: readInputSchema,
        outputSchema: readOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: (input, context) => readWorkspaceFile(guard, options, input, context.toolName, context.toolCallId),
        toModelOutput: readModelOutput,
    };
}

function createReadTaggedTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<ReadInput, ReadOutput> {
    return {
        name: 'repo.read.tagged',
        description:
            'Read a workspace file with each line tagged as NN#XX|content. Use the NN#XX anchors in a follow-up hashline_edit call. Output is NOT byte-identical to repo.read (it carries the anchors); use repo.read for raw content.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: readParametersJsonSchema(),
        inputSchema: readInputSchema,
        outputSchema: readOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: (input, context) =>
            readWorkspaceFile(guard, options, { ...input, tagged: true }, context.toolName, context.toolCallId),
        toModelOutput: readModelOutput,
    };
}

function createListAliasTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
): ToolRegistration<ListInput, ListOutput> {
    return {
        name: 'ls',
        description: 'List directory entries inside the workspace.',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: listParametersJsonSchema(),
        inputSchema: listInputSchema,
        outputSchema: listOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: (input, context) =>
            listWorkspaceDirectory(guard, options, input, context.toolName, context.toolCallId),
        toModelOutput: (output) =>
            output.entries.map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join('\n'),
    };
}

function createSearchAliasTool(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
    name: 'grep' | 'find',
    description: string,
): ToolRegistration<SearchInput, SearchOutput> {
    return {
        name,
        description,
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: searchParametersJsonSchema(),
        inputSchema: searchInputSchema,
        outputSchema: searchOutputSchema,
        outputLimit: { maxModelOutputChars: options.maxModelOutputChars },
        execute: async (input, context) => {
            await requireReadPermission(options, context.toolCallId, context.toolName, [
                input.path ?? '.',
                input.include ?? '.',
            ]);
            const result = await searchRepoText(
                guard,
                searchInputForExecution(input),
                {
                    maxMatches: options.maxSearchMatches,
                    maxLineChars: options.maxSearchLineChars,
                },
                options.natives,
            );
            return {
                kind: 'search',
                pattern: input.pattern,
                path: input.path ?? '.',
                matches: [...result.matches],
                truncated: result.totalMatches > result.matches.length,
                totalMatches: result.totalMatches,
            };
        },
        toModelOutput: searchModelOutput,
    };
}

function searchInputForExecution(input: SearchInput) {
    return {
        pattern: input.pattern,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.include !== undefined ? { include: input.include } : {}),
    };
}

async function readWorkspaceFile(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
    input: ReadInput,
    action: string,
    toolCallId: string,
): Promise<ReadOutput> {
    if (options.schemeResolver !== undefined) {
        const intercepted = await interceptRead(options.schemeResolver, input.path);
        if (intercepted !== undefined) {
            return readOutputFromScheme(input.path, intercepted);
        }
    }
    await requireReadPermission(options, toolCallId, action, [input.path]);
    const target = await guard.resolveExisting(input.path);
    if (!target.stats.isFile()) {
        throw repoToolFailure('not_file', `path is not a file: ${input.path}`);
    }
    const sample = await readFilePrefix(target.absolutePath, Math.min(options.maxReadBytes, 4096));
    if (isBinarySample(sample)) {
        throw repoToolFailure('binary_file', `binary file cannot be read as text: ${input.path}`);
    }
    const contentBytes =
        sample.length < options.maxReadBytes ? sample : await readFilePrefix(target.absolutePath, options.maxReadBytes);
    const content = selectLines(contentBytes.toString('utf8'), input);
    const baseOutput = {
        kind: 'file' as const,
        path: target.relativePath,
        content,
        truncated: target.stats.size > contentBytes.length,
        originalBytes: target.stats.size,
        returnedBytes: contentBytes.length,
    };
    // Tagged mode: prefix every line with a `NN#XX|` content-hash anchor so a
    // follow-up hashline_edit can reference lines by their anchor. Line numbers
    // reflect the window start (`offset`) so a windowed tagged read keeps its
    // anchors aligned with the source file. Tagged mode is mutually exclusive
    // with the structural summary (elided bodies would carry meaningless tags).
    if (input.tagged === true) {
        const startLine = input.offset ?? 1;
        const tagged = tagLinesWithAnchors(content, startLine);
        return {
            ...baseOutput,
            content: tagged,
            returnedBytes: Buffer.byteLength(tagged, 'utf8'),
        };
    }
    // Structural summary is the DEFAULT read output for supported languages.
    // It is applied only to the already-vetted file CONTENT, never changing
    // the path guard or denylist. Line-windowed reads (`offset` / `limit`),
    // an explicit `summary: false` opt-out, an unavailable addon, an
    // unsupported language, a parse failure, or a file too small to elide
    // all fall back to the raw text above.
    if (
        input.summary !== false &&
        input.offset === undefined &&
        input.limit === undefined &&
        options.natives !== undefined
    ) {
        const result = options.natives.summarizeCode({ code: content, path: target.relativePath });
        if (result !== null && result.parsed && result.elided) {
            const { text, elidedLines } = renderSummaryContent(result);
            return {
                ...baseOutput,
                content: text,
                returnedBytes: Buffer.byteLength(text, 'utf8'),
                summarized: true,
                elidedLines,
            };
        }
    }
    return baseOutput;
}

function readOutputFromScheme(
    sourceLabel: string,
    intercepted: { readonly content: string; readonly notes: readonly string[] },
): ReadOutput {
    const contentBytes = Buffer.from(intercepted.content, 'utf8');
    const notePrefix = intercepted.notes.length > 0 ? `\n\n${intercepted.notes.join('\n')}` : '';
    return {
        kind: 'file',
        path: sourceLabel,
        content: intercepted.content + notePrefix,
        truncated: false,
        originalBytes: contentBytes.length,
        returnedBytes: contentBytes.length,
    };
}

function tagLinesWithAnchors(content: string, startLine: number): string {
    if (content.length === 0) {
        return '';
    }
    const lines = content.split('\n');
    return lines
        .map((line, index) => `${startLine + index}#${computeLineHash(startLine + index, line)}|${line}`)
        .join('\n');
}

// Render a structural summary as model-facing text: kept segments verbatim,
// each elided span as an ASCII `... // N lines elided` marker. Imports and
// signatures live in kept segments; bodies collapse to the markers.
function renderSummaryContent(result: NativeSummaryResult): { text: string; elidedLines: number } {
    const parts: string[] = [];
    let elidedLines = 0;
    for (const segment of result.segments) {
        if (segment.kind === 'kept') {
            parts.push(segment.text ?? '');
        } else {
            const spanLines = Math.max(0, segment.endLine - segment.startLine + 1);
            elidedLines += spanLines;
            parts.push(`... // ${spanLines} line${spanLines === 1 ? '' : 's'} elided`);
        }
    }
    return { text: parts.join('\n'), elidedLines };
}

async function listWorkspaceDirectory(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
    input: ListInput,
    action: string,
    toolCallId: string,
): Promise<ListOutput> {
    await requireReadPermission(options, toolCallId, action, [input.path ?? '.']);
    const target = await guard.resolveExisting(input.path ?? '.');
    if (!target.stats.isDirectory()) {
        throw repoToolFailure('not_directory', `path is not a directory: ${input.path ?? '.'}`);
    }
    const entries = (await readdir(target.absolutePath, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    const visibleEntries = entries.filter(
        (entry) => !guard.isDeniedAbsolutePath(join(target.absolutePath, entry.name)),
    );
    return {
        kind: 'directory',
        path: target.relativePath,
        entries: visibleEntries.slice(0, options.maxListEntries).map((entry) => ({
            name: entry.name,
            kind: entryKind(entry),
        })),
        truncated: visibleEntries.length > options.maxListEntries,
        totalEntries: visibleEntries.length,
    };
}

async function readFilePrefix(path: string, bytes: number): Promise<Buffer> {
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const result = await file.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, result.bytesRead);
    } finally {
        await file.close();
    }
}

function selectLines(content: string, input: ReadInput): string {
    if (input.offset === undefined && input.limit === undefined) {
        return content;
    }
    const lines = content.split(/\r?\n/);
    const start = (input.offset ?? 1) - 1;
    return lines.slice(start, input.limit === undefined ? undefined : start + input.limit).join('\n');
}

function entryKind(entry: { isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) {
    if (entry.isDirectory()) return 'directory' as const;
    if (entry.isFile()) return 'file' as const;
    if (entry.isSymbolicLink()) return 'symlink' as const;
    return 'other' as const;
}

async function requireReadPermission(
    options: ReadOnlyRepoToolOptions,
    toolCallId: string,
    action: string,
    patterns: readonly string[],
): Promise<void> {
    if (options.requestPermission === undefined) {
        return;
    }
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId,
            action,
            reason: `${action} within workspace`,
            permission: 'read',
            patterns,
            workspaceRoot: options.workspaceRoot,
        }),
    );
    if (decision.status === 'allow') {
        return;
    }
    throw repoToolFailure(
        'read_failed',
        `${decision.status === 'deny' ? 'permission_denied' : 'approval_required'}: ${
            decision.reason ?? `${action} denied`
        }`,
    );
}
