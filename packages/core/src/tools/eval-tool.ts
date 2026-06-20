/**
 * `eval` tool (Task 22).
 *
 * Executes one or more JavaScript cells in a persistent sandbox built on
 * `EvalContextManager`. A single context manager is created per tool invocation
 * so `var` declarations persist across cells within the same call. Each cell
 * produces an `EvalCellResult` with captured output, exit code, truncation, and
 * timeout flags.
 *
 * Tool re-entry from inside the sandbox is handled by `eval-tool-bridge.ts`,
 * which is a standalone module in this iteration; Task 23 will wire the bridge
 * into the execution path. The tool functions correctly without the bridge.
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
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

const EVAL_TOOL_NAME = 'eval';
const DEFAULT_MODEL_OUTPUT_CHARS = 8_000;

const EVAL_TOOL_DESCRIPTION =
    'Execute JavaScript code in a persistent sandbox. State persists across calls. Read-only agent tools (read, grep) are accessible from inside the sandbox.';
const EVAL_TOOL_GUIDELINE =
    'Use eval for data processing, calculations, and multi-step code that benefits from persistent state. The sandbox has access to read-only workspace tools.';

export type EvalToolOptions = {
    readonly workspaceRoot: string;
};

export async function registerEvalTool(registry: ToolRegistry, options: EvalToolOptions): Promise<ToolAdvertisement> {
    return registry.register(createEvalToolRegistration(options));
}

export function createEvalToolRegistration(options: EvalToolOptions): ToolRegistration<EvalInput, EvalOutput> {
    // workspaceRoot is reserved for Task 23 wiring: the tool re-entry bridge will
    // use it to construct read-only repo tools when the worker requests them from
    // inside the sandbox. The tool works without it in this iteration.
    void options.workspaceRoot;

    return {
        name: EVAL_TOOL_NAME,
        description: EVAL_TOOL_DESCRIPTION,
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: evalParametersJsonSchema(),
        inputSchema: evalInputSchema,
        outputSchema: evalOutputSchema,
        outputLimit: { maxModelOutputChars: DEFAULT_MODEL_OUTPUT_CHARS },
        execute: (input) => runEvalCells(input.cells),
        toModelOutput: formatEvalModelOutput,
        guideline: EVAL_TOOL_GUIDELINE,
    };
}

async function runEvalCells(cells: readonly EvalCell[]): Promise<EvalOutput> {
    const manager = new EvalContextManager();
    try {
        const results: EvalCellResult[] = [];
        for (const cell of cells) {
            const run = await manager.runCode({
                code: cell.code,
                ...(cell.timeoutMs !== undefined ? { timeoutMs: cell.timeoutMs } : {}),
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
