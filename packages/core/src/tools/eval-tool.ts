/**
 * `eval` tool (Task 19 / 22).
 *
 * Executes one or more cells in persistent local runtimes built on
 * `EvalContextManager`, which coordinates a JavaScript VM (`node:worker_threads`
 * + `node:vm`) and a persistent Python kernel subprocess. State persists across
 * cells of the same language within one invocation, and both runtimes share a
 * common prelude that exposes read-only agent tools through the tool re-entry
 * bridge (`eval-tool-bridge.ts`): a cell can `await read(...)` (JS) or call
 * `read(...)` (Python) to re-enter host read-only tools scoped to the workspace.
 */

import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { type ProjectTrustReader, resolveProjectTrustDecision } from '../trust/project-trust-store';
import { EvalContextManager, type EvalContextManagerOptions, type EvalRunResult } from './eval-context-manager';
import {
    type EvalCell,
    type EvalCellResult,
    type EvalInput,
    type EvalOutput,
    evalInputSchema,
    evalOutputSchema,
    evalParametersJsonSchema,
} from './eval-schemas';
import { createEvalToolBridge } from './eval-tool-bridge';
import { createEvalToolHost } from './eval-tool-host';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { ToolRegistry } from './tool-registry';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration } from './tool-registry-types';

const EVAL_TOOL_NAME = 'eval';
const DEFAULT_MODEL_OUTPUT_CHARS = 8_000;
const EVAL_PERMISSION_REASON = 'execute JavaScript or Python code in persistent local runtimes';

const EVAL_TOOL_DESCRIPTION =
    'Execute JavaScript or Python code with host-user privileges in persistent local runtimes. Python uses isolated startup mode (-I), not a security sandbox. State persists across cells of the same language. Read-only agent tools (read, grep, search) are accessible through the tool bridge; JS cells must await them.';
const EVAL_TOOL_GUIDELINE =
    'Use eval for data processing, calculations, and multi-step code that benefits from persistent state. Eval code is not sandboxed and requires bash-class approval before its local runtime starts.';

type EvalContextManagerHandle = Pick<EvalContextManager, 'runCode' | 'close'>;

export type EvalContextManagerFactory = (options: EvalContextManagerOptions) => EvalContextManagerHandle;

export type EvalToolOptions = {
    readonly workspaceRoot: string;
    readonly projectTrustStore: ProjectTrustReader;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly pythonBin?: string;
    readonly contextManagerFactory?: EvalContextManagerFactory;
};

export async function registerEvalTool(registry: ToolRegistry, options: EvalToolOptions): Promise<ToolAdvertisement> {
    return registry.register(createEvalToolRegistration(options));
}

export function createEvalToolRegistration(options: EvalToolOptions): ToolRegistration<EvalInput, EvalOutput> {
    const bridge = createEvalToolBridge({ invokeTool: createEvalToolHost(options.workspaceRoot) });
    const contextManagerFactory =
        options.contextManagerFactory ?? ((managerOptions) => new EvalContextManager(managerOptions));

    return {
        name: EVAL_TOOL_NAME,
        description: EVAL_TOOL_DESCRIPTION,
        capabilityClasses: ['bash.run'],
        parametersJsonSchema: evalParametersJsonSchema(),
        inputSchema: evalInputSchema,
        outputSchema: evalOutputSchema,
        outputLimit: { maxModelOutputChars: DEFAULT_MODEL_OUTPUT_CHARS },
        execute: async (input, context) => {
            await requireEvalWorkspaceTrust(options);
            const request = permissionRequest({
                toolCallId: context.toolCallId,
                action: EVAL_TOOL_NAME,
                reason: EVAL_PERMISSION_REASON,
                permission: 'bash',
                patterns: [EVAL_TOOL_NAME],
                workspaceRoot: options.workspaceRoot,
            });
            const decision = await requestToolPermission(options.requestPermission, request);
            if (decision.status !== 'allow') {
                throw evalApprovalFailure(decision);
            }
            await requireEvalWorkspaceTrust(options);
            if (context.signal.aborted) {
                throw new ToolExecutionError({
                    code: 'operator_aborted',
                    message: 'eval interrupted before runtime start',
                    retryable: false,
                });
            }
            return runEvalCells(input.cells, {
                bridge,
                contextManagerFactory,
                signal: context.signal,
                ...(options.pythonBin !== undefined ? { pythonBin: options.pythonBin } : {}),
            });
        },
        toModelOutput: formatEvalModelOutput,
        guideline: EVAL_TOOL_GUIDELINE,
    };
}

async function requireEvalWorkspaceTrust(options: EvalToolOptions): Promise<void> {
    const decision = await resolveProjectTrustDecision(options.workspaceRoot, options.projectTrustStore);
    if (decision === 'trusted') {
        return;
    }
    throw new ToolExecutionError({
        code: 'tool_failed',
        message: `workspace_trust_required: eval requires canonical workspace trust (decision: ${decision})`,
        retryable: false,
    });
}

type EvalRunContext = {
    readonly bridge: ReturnType<typeof createEvalToolBridge>;
    readonly contextManagerFactory: EvalContextManagerFactory;
    readonly signal: AbortSignal;
    readonly pythonBin?: string;
};

async function runEvalCells(cells: readonly EvalCell[], context: EvalRunContext): Promise<EvalOutput> {
    const manager = context.contextManagerFactory({
        bridge: context.bridge,
        ...(context.pythonBin !== undefined ? { pythonBin: context.pythonBin } : {}),
    });
    try {
        const results: EvalCellResult[] = [];
        for (const cell of cells) {
            const run = await manager.runCode({
                code: cell.code,
                language: cell.language,
                signal: context.signal,
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

function evalApprovalFailure(decision: PermissionDecision): ToolExecutionError {
    const code = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    return new ToolExecutionError({
        code: 'tool_failed',
        message: `${code}: ${decision.reason ?? 'eval approval was not granted'}`,
        retryable: true,
    });
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
