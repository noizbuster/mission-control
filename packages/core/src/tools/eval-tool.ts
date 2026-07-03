/**
 * `eval` tool (Task 19 / 22).
 *
 * Executes one or more cells in a persistent sandbox built on
 * `EvalContextManager`, which coordinates a JavaScript VM (`node:worker_threads`
 * + `node:vm`) and a persistent Python kernel subprocess. State persists across
 * cells of the same language within one invocation, and both runtimes share a
 * common prelude that exposes read-only agent tools through the tool re-entry
 * bridge (`eval-tool-bridge.ts`): a cell can `await read(...)` (JS) or call
 * `read(...)` (Python) to re-enter host read-only tools scoped to the workspace.
 */

import { EvalContextManager, type EvalRunResult } from './eval-context-manager.js';
import {
    type EvalCell,
    type EvalCellResult,
    type EvalInput,
    type EvalOutput,
    evalInputSchema,
    evalOutputSchema,
    evalParametersJsonSchema,
} from './eval-schemas.js';
import { createEvalToolBridge } from './eval-tool-bridge.js';
import { matchesWorkspaceDenylist } from './read-tools-paths.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const EVAL_TOOL_NAME = 'eval';
const DEFAULT_MODEL_OUTPUT_CHARS = 8_000;
const BRIDGE_READ_CAP_BYTES = 256 * 1024;

const EVAL_TOOL_DESCRIPTION =
    'Execute JavaScript or Python code in a persistent sandbox. State persists across cells of the same language. Read-only agent tools (read, grep, search) are accessible from inside the sandbox via the tool bridge; JS cells must await them.';
const EVAL_TOOL_GUIDELINE =
    'Use eval for data processing, calculations, and multi-step code that benefits from persistent state. The sandbox has access to read-only workspace tools through the bridge.';

export type EvalToolOptions = {
    readonly workspaceRoot: string;
    readonly pythonBin?: string;
};

export async function registerEvalTool(registry: ToolRegistry, options: EvalToolOptions): Promise<ToolAdvertisement> {
    return registry.register(createEvalToolRegistration(options));
}

export function createEvalToolRegistration(options: EvalToolOptions): ToolRegistration<EvalInput, EvalOutput> {
    const bridge = createEvalToolBridge({ invokeTool: createEvalToolHost(options.workspaceRoot) });

    return {
        name: EVAL_TOOL_NAME,
        description: EVAL_TOOL_DESCRIPTION,
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: evalParametersJsonSchema(),
        inputSchema: evalInputSchema,
        outputSchema: evalOutputSchema,
        outputLimit: { maxModelOutputChars: DEFAULT_MODEL_OUTPUT_CHARS },
        execute: (input) =>
            runEvalCells(input.cells, {
                workspaceRoot: options.workspaceRoot,
                bridge,
                ...(options.pythonBin !== undefined ? { pythonBin: options.pythonBin } : {}),
            }),
        toModelOutput: formatEvalModelOutput,
        guideline: EVAL_TOOL_GUIDELINE,
    };
}

type EvalRunContext = {
    readonly workspaceRoot: string;
    readonly bridge: ReturnType<typeof createEvalToolBridge>;
    readonly pythonBin?: string;
};

async function runEvalCells(cells: readonly EvalCell[], context: EvalRunContext): Promise<EvalOutput> {
    const manager = new EvalContextManager({
        bridge: context.bridge,
        ...(context.pythonBin !== undefined ? { pythonBin: context.pythonBin } : {}),
    });
    void context.workspaceRoot;
    try {
        const results: EvalCellResult[] = [];
        for (const cell of cells) {
            const run = await manager.runCode({
                code: cell.code,
                language: cell.language,
                ...(cell.timeoutMs !== undefined ? { timeoutMs: cell.timeoutMs } : {}),
                ...(cell.reset !== undefined ? { reset: cell.reset } : {}),
            });
            results.push(toCellResult(cell, run));
        }
        return { results };
    } finally {
        await manager.close();
    }
}

function toCellResult(cell: EvalCell, run: EvalRunResult): EvalCellResult {
    return {
        ...(cell.title !== undefined ? { title: cell.title } : {}),
        output: run.output,
        exitCode: run.exitCode,
        truncated: run.truncated,
        timedOut: run.timedOut,
    };
}

function formatEvalModelOutput(output: EvalOutput): string {
    if (output.results.length === 0) {
        return 'No cells were executed.';
    }
    const blocks = output.results.map((result, index) => formatCellBlock(result, index));
    return blocks.join('\n\n');
}

function formatCellBlock(result: EvalCellResult, index: number): string {
    const heading = result.title !== undefined ? `## Cell ${index + 1}: ${result.title}` : `## Cell ${index + 1}`;
    const lines: string[] = [heading];
    if (result.timedOut) {
        lines.push('(timed out)');
    }
    const trimmed = result.output.endsWith('\n') ? result.output.slice(0, -1) : result.output;
    if (trimmed.length > 0) {
        lines.push(trimmed);
    }
    if (result.exitCode !== 0) {
        lines.push(`[exit code: ${result.exitCode}]`);
    }
    if (result.truncated) {
        lines.push('[output truncated]');
    }
    return lines.join('\n');
}

/**
 * Contained, read-only tool host the eval bridge re-enters. Resolves every path
 * against the workspace root, rejects escapes and denylisted directories, and
 * exposes only the read-only surface the bridge allowlist already permits
 * (`read`, `ls`, `grep`, `search`, `find`, `glob`, `repo.*`). Output is capped so
 * a cell cannot pull unbounded data back through the bridge.
 */
function createEvalToolHost(workspaceRoot: string): (name: string, args: unknown) => Promise<unknown> {
    return async (name, args) => {
        const argRecord = isRecord(args) ? args : {};
        switch (name) {
            case 'read':
            case 'repo.read':
                return readWorkspaceFile(workspaceRoot, stringField(argRecord, 'path'));
            case 'ls':
            case 'repo.list':
                return listWorkspaceDir(workspaceRoot, stringField(argRecord, 'path'));
            case 'grep':
            case 'search':
            case 'repo.search':
                return searchWorkspaceText(workspaceRoot, stringField(argRecord, 'pattern'), argRecord);
            case 'find':
            case 'glob':
                return findWorkspaceGlob(workspaceRoot, stringField(argRecord, 'pattern'));
            default:
                throw new Error(`eval bridge does not implement tool: ${name}`);
        }
    };
}

function resolveContained(root: string, requestedPath: string): string {
    if (requestedPath.length === 0) {
        throw new Error('eval bridge: path is required');
    }
    const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath);
    const rel = relative(root, absolute);
    const contained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!contained) {
        throw new Error(`eval bridge: path escapes workspace: ${requestedPath}`);
    }
    if (matchesWorkspaceDenylist(rel) && rel !== '') {
        throw new Error(`eval bridge: path is denylisted: ${requestedPath}`);
    }
    return absolute;
}

async function readWorkspaceFile(root: string, requestedPath: string): Promise<string> {
    const absolute = resolveContained(root, requestedPath);
    const content = await readFile(absolute, 'utf8');
    if (content.length > BRIDGE_READ_CAP_BYTES) {
        return content.slice(0, BRIDGE_READ_CAP_BYTES);
    }
    return content;
}

async function listWorkspaceDir(root: string, requestedPath: string): Promise<readonly string[]> {
    const absolute = resolveContained(root, requestedPath.length === 0 ? '.' : requestedPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
}

async function searchWorkspaceText(
    root: string,
    pattern: string,
    argRecord: Record<string, unknown>,
): Promise<readonly { readonly path: string; readonly line: string }[]> {
    if (pattern.length === 0) {
        return [];
    }
    const path = stringField(argRecord, 'path');
    const absolute = resolveContained(root, path.length === 0 ? '.' : path);
    const stat = await safeStat(absolute);
    if (stat === undefined) {
        return [];
    }
    if (stat.isFile) {
        return searchInFile(root, absolute, pattern);
    }
    return [];
}

async function searchInFile(
    root: string,
    absolute: string,
    pattern: string,
): Promise<readonly { readonly path: string; readonly line: string }[]> {
    const content = await readFile(absolute, 'utf8');
    const rel = relative(root, absolute);
    const matches: { readonly path: string; readonly line: string }[] = [];
    for (const line of content.split('\n')) {
        if (line.includes(pattern)) {
            matches.push({ path: rel, line });
            if (matches.length >= 50) {
                break;
            }
        }
    }
    return matches;
}

async function findWorkspaceGlob(root: string, pattern: string): Promise<readonly string[]> {
    const effectivePattern = pattern.length === 0 ? '**/*' : pattern;
    const regex = globToRegExp(effectivePattern);
    const results: string[] = [];
    await walk(root, root, regex, results, 0);
    return results;
}

async function walk(root: string, current: string, regex: RegExp, results: string[], depth: number): Promise<void> {
    if (depth > 12 || results.length >= 200) {
        return;
    }
    let entries: Dirent[];
    try {
        entries = await readdir(current, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const rel = relative(root, resolve(current, entry.name));
        if (rel !== '' && matchesWorkspaceDenylist(rel)) {
            continue;
        }
        const full = entry.isDirectory() ? `${rel}/` : rel;
        if (regex.test(rel) || regex.test(full)) {
            results.push(rel);
        }
        if (entry.isDirectory()) {
            await walk(root, resolve(current, entry.name), regex, results, depth + 1);
        }
    }
}

function globToRegExp(pattern: string): RegExp {
    let re = '';
    for (const char of pattern) {
        if (char === '*') {
            re += '[^/]*';
        } else if (char === '?') {
            re += '[^/]';
        } else if ('.+^${}()|[]\\'.includes(char)) {
            re += `\\${char}`;
        } else {
            re += char;
        }
    }
    return new RegExp(`^${re}$`);
}

async function safeStat(
    absolute: string,
): Promise<{ readonly isFile: boolean; readonly isDirectory: boolean } | undefined> {
    try {
        const stats = await stat(absolute);
        return { isFile: stats.isFile(), isDirectory: stats.isDirectory() };
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
