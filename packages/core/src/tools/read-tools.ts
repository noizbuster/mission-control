import { repoToolFailure } from './read-tools-errors.js';
import { createWorkspaceGuard, isBinarySample, type WorkspaceGuard } from './read-tools-paths.js';
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
} from './read-tools-schemas.js';
import { searchRepoText } from './read-tools-search.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { open, readdir } from 'node:fs/promises';

export type { ReadOnlyRepoToolOptions } from './read-tools-schemas.js';

type ReadOnlyRepoToolRegistrations = readonly [
    ToolRegistration<ReadInput, ReadOutput>,
    ToolRegistration<ListInput, ListOutput>,
    ToolRegistration<SearchInput, SearchOutput>,
];

export async function registerReadOnlyRepoTools(
    registry: ToolRegistry,
    options: ReadOnlyRepoToolOptions,
): Promise<readonly ToolAdvertisement[]> {
    const [readTool, listTool, searchTool] = await createReadOnlyRepoToolRegistrations(options);
    return [registry.register(readTool), registry.register(listTool), registry.register(searchTool)];
}

export async function createReadOnlyRepoToolRegistrations(
    options: ReadOnlyRepoToolOptions,
): Promise<ReadOnlyRepoToolRegistrations> {
    const guard = await createWorkspaceGuard(options.workspaceRoot);
    const resolved = resolveOptions(options);
    return [createReadTool(guard, resolved), createListTool(guard, resolved), createSearchTool(guard, resolved)];
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
        execute: (input) => readWorkspaceFile(guard, options, input),
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
        execute: (input) => listWorkspaceDirectory(guard, options, input),
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
        execute: async (input) => {
            const result = await searchRepoText(guard, searchInputForExecution(input), {
                maxMatches: options.maxSearchMatches,
                maxLineChars: options.maxSearchLineChars,
            });
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
): Promise<ReadOutput> {
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
    return {
        kind: 'file',
        path: target.relativePath,
        content,
        truncated: target.stats.size > contentBytes.length,
        originalBytes: target.stats.size,
        returnedBytes: contentBytes.length,
    };
}

async function listWorkspaceDirectory(
    guard: WorkspaceGuard,
    options: ResolvedReadOnlyRepoToolOptions,
    input: ListInput,
): Promise<ListOutput> {
    const target = await guard.resolveExisting(input.path ?? '.');
    if (!target.stats.isDirectory()) {
        throw repoToolFailure('not_directory', `path is not a directory: ${input.path ?? '.'}`);
    }
    const entries = (await readdir(target.absolutePath, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    return {
        kind: 'directory',
        path: target.relativePath,
        entries: entries.slice(0, options.maxListEntries).map((entry) => ({
            name: entry.name,
            kind: entryKind(entry),
        })),
        truncated: entries.length > options.maxListEntries,
        totalEntries: entries.length,
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
