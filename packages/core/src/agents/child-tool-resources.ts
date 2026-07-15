import type { CommandChain } from '../tools/bash-run-command-guard';
import { assertAllowedCommandChain } from '../tools/bash-run-policy';
import { bashRunInputSchema } from '../tools/bash-run-schemas';
import { buildPermissionPatterns } from '../tools/command-run-policy';
import { commandRunInputSchema } from '../tools/command-run-schemas';
import { fileEditInputSchema } from '../tools/file-edit-schemas';
import { parseUnifiedPatch, targetPath } from '../tools/file-patch-parser';
import { filePatchInputSchema } from '../tools/file-patch-schemas';
import { fileWriteInputSchema } from '../tools/file-write-schemas';
import { globInputSchema } from '../tools/glob-tool';
import { listInputSchema, readInputSchema, searchInputSchema } from '../tools/read-tools-schemas';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { relative, resolve, sep } from 'node:path';

export type PolicyResource = {
    readonly kind: 'path' | 'literal';
    readonly value: string;
};

export type ResourceResolution =
    | { readonly kind: 'resolved'; readonly resources: readonly PolicyResource[] }
    | { readonly kind: 'malformed' }
    | { readonly kind: 'unsupported' };

const MALFORMED_RESOURCES: ResourceResolution = { kind: 'malformed' };
const UNSUPPORTED_RESOURCES: ResourceResolution = { kind: 'unsupported' };

export function resourcesForChildInvocation(toolName: string, parsedArguments: unknown): ResourceResolution {
    switch (toolName) {
        case 'file.write': {
            const parsed = fileWriteInputSchema.safeParse(parsedArguments);
            return parsed.success ? resolvedPaths([parsed.data.path]) : MALFORMED_RESOURCES;
        }
        case 'file.edit': {
            const parsed = fileEditInputSchema.safeParse(parsedArguments);
            return parsed.success ? resolvedPaths([parsed.data.path]) : MALFORMED_RESOURCES;
        }
        case 'file.patch': {
            const parsed = filePatchInputSchema.safeParse(parsedArguments);
            if (!parsed.success) return MALFORMED_RESOURCES;
            try {
                return resolvedPaths(parseUnifiedPatch(parsed.data.patch).map(targetPath));
            } catch (error: unknown) {
                if (error instanceof ToolExecutionError) return MALFORMED_RESOURCES;
                throw error;
            }
        }
        case 'command.run': {
            const parsed = commandRunInputSchema.safeParse(parsedArguments);
            if (!parsed.success) return MALFORMED_RESOURCES;
            const command = [parsed.data.command, ...parsed.data.args];
            return resolvedCommandPatterns(buildPermissionPatterns(command.join(' '), command));
        }
        case 'bash.run': {
            const parsed = bashRunInputSchema.safeParse(parsedArguments);
            if (!parsed.success) return MALFORMED_RESOURCES;
            try {
                const chain = assertAllowedCommandChain(parsed.data.commandLine);
                return bashPermissionPatterns(parsed.data.commandLine, chain, parsed.data.cwd);
            } catch (error: unknown) {
                if (error instanceof ToolExecutionError) return MALFORMED_RESOURCES;
                throw error;
            }
        }
        case 'repo.read':
        case 'repo.read.tagged':
        case 'read': {
            const parsed = readInputSchema.safeParse(parsedArguments);
            return parsed.success ? resolvedPaths([parsed.data.path]) : MALFORMED_RESOURCES;
        }
        case 'repo.list':
        case 'ls': {
            const parsed = listInputSchema.safeParse(parsedArguments);
            return parsed.success ? resolvedPaths([parsed.data.path ?? '.']) : MALFORMED_RESOURCES;
        }
        case 'repo.search':
        case 'grep':
        case 'find': {
            const parsed = searchInputSchema.safeParse(parsedArguments);
            return parsed.success
                ? resolvedResources([
                      pathResource(parsed.data.path ?? '.'),
                      literalResource(parsed.data.include ?? '.'),
                  ])
                : MALFORMED_RESOURCES;
        }
        case 'glob': {
            const parsed = globInputSchema.safeParse(parsedArguments);
            return parsed.success
                ? resolvedResources([pathResource(parsed.data.path ?? '.'), literalResource(parsed.data.pattern)])
                : MALFORMED_RESOURCES;
        }
        default:
            return UNSUPPORTED_RESOURCES;
    }
}

export function childPolicyResourceValue(resource: PolicyResource, workspaceRoot: string): string {
    if (resource.kind === 'literal') return resource.value;
    const workspaceRelative = relative(workspaceRoot, resolve(workspaceRoot, resource.value));
    if (workspaceRelative.length === 0) return '.';
    return workspaceRelative.split(sep).join('/');
}

function bashPermissionPatterns(commandLine: string, chain: CommandChain, cwd: string | undefined): ResourceResolution {
    const resources: PolicyResource[] = [literalResource(commandLine)];
    if (cwd !== undefined) resources.push(pathResource(cwd));
    for (const pipeline of chain.pipelines) {
        for (const segment of pipeline) {
            for (const [index, pattern] of buildPermissionPatterns(segment.join(' '), segment).entries()) {
                const resource = index === 0 ? literalResource(pattern) : pathResource(pattern);
                if (
                    !resources.some((existing) => existing.kind === resource.kind && existing.value === resource.value)
                ) {
                    resources.push(resource);
                }
            }
        }
    }
    return resolvedResources(resources);
}

function resolvedCommandPatterns(patterns: readonly string[]): ResourceResolution {
    return resolvedResources(
        patterns.map((pattern, index) => (index === 0 ? literalResource(pattern) : pathResource(pattern))),
    );
}

function resolvedPaths(paths: readonly string[]): ResourceResolution {
    return resolvedResources(paths.map(pathResource));
}

function resolvedResources(resources: readonly PolicyResource[]): ResourceResolution {
    return { kind: 'resolved', resources };
}

function pathResource(value: string): PolicyResource {
    return { kind: 'path', value };
}

function literalResource(value: string): PolicyResource {
    return { kind: 'literal', value };
}
