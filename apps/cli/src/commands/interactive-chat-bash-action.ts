import { ProjectTrustStore, redactCredentialText } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { execSync } from 'node:child_process';

export type BashAction = { readonly kind: 'bash'; readonly command: string };
export type BashDisplayOnlyAction = { readonly kind: 'bash-display-only'; readonly command: string };

/**
 * Submits the formatted bash output as a new user prompt to the model. Mirrors
 * {@link startPromptTurn}. Injected so the handler stays decoupled from the
 * runtime and unit-testable without a live provider/session store.
 */
export type BashPromptSubmitter = (prompt: string) => Promise<ActiveCodingAgentTurn | undefined>;

const bashTimeoutMs = 30_000;
const bashMaxBufferBytes = 64 * 1024;

/**
 * Runs `!command`: executes the command, writes the formatted output to the
 * chat, and submits the command + output as a user prompt so the model receives
 * the bash context. Requires a trusted workspace (same gate as the `bash.run`
 * tool).
 */
export async function runBashAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    action: BashAction,
    submitPrompt: BashPromptSubmitter,
): Promise<ChatActionResult> {
    const workspaceRoot = coding.workspaceRoot;
    if (workspaceRoot === undefined) {
        chatOutput.write('Error: bash mode requires a workspace. Start the chat from a project directory.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (!(await isWorkspaceTrusted(workspaceRoot))) {
        chatOutput.write('Error: bash mode requires a trusted workspace. Use /trust to trust this workspace.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const result = executeBashCommand(action.command, workspaceRoot);
    if (result.kind === 'failure') {
        chatOutput.write(formatBashFailure(result));
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const formatted = formatBashOutput(action.command, result.output);
    chatOutput.write(formatted);
    const activeTurn = await submitPrompt(formatted);
    return actionResult(modelProviderSelection, activeTurn);
}

/**
 * Runs `!!command`: executes the command and writes the formatted output to the
 * chat for the user, but does NOT submit anything to the model. Same trust gate
 * as {@link runBashAction}.
 */
export async function runBashDisplayOnlyAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    action: BashDisplayOnlyAction,
): Promise<ChatActionResult> {
    const workspaceRoot = coding.workspaceRoot;
    if (workspaceRoot === undefined) {
        chatOutput.write('Error: bash mode requires a workspace. Start the chat from a project directory.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (!(await isWorkspaceTrusted(workspaceRoot))) {
        chatOutput.write('Error: bash mode requires a trusted workspace. Use /trust to trust this workspace.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const result = executeBashCommand(action.command, workspaceRoot);
    if (result.kind === 'failure') {
        chatOutput.write(formatBashFailure(result));
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    chatOutput.write(formatBashOutput(action.command, result.output));
    return actionResult(modelProviderSelection, coding.activeTurn);
}

async function isWorkspaceTrusted(workspaceRoot: string): Promise<boolean> {
    const store = new ProjectTrustStore();
    const lookup = await store.getDecision(workspaceRoot);
    return lookup.decision === 'trusted';
}

type BashExecResult =
    | { readonly kind: 'success'; readonly output: string }
    | { readonly kind: 'failure'; readonly message: string; readonly output: string };

/**
 * Executes the command via execSync. stderr is merged into stdout (`2>&1`) so
 * the captured output contains both streams. On non-zero exit or timeout,
 * execSync throws; the thrown error carries the partial stdout/stderr plus
 * status/signal. The shell redirect ensures error.stdout holds the merged
 * partial output.
 */
function executeBashCommand(command: string, cwd: string): BashExecResult {
    try {
        const output = execSync(`${command} 2>&1`, {
            encoding: 'utf-8',
            timeout: bashTimeoutMs,
            maxBuffer: bashMaxBufferBytes,
            cwd,
        });
        return { kind: 'success', output };
    } catch (error) {
        return { kind: 'failure', message: bashFailureMessage(error), output: bashCapturedOutput(error) };
    }
}

function formatBashOutput(command: string, output: string): string {
    // Redact command + output together: the command line can itself carry secrets.
    const block = output.endsWith('\n') ? output : `${output}\n`;
    return redactCredentialText(`! ${command}\n${block}`);
}

function formatBashFailure(result: { readonly message: string; readonly output: string }): string {
    const captured = redactCredentialText(result.output).trim();
    if (captured.length === 0) {
        return `Error: ${result.message}\n`;
    }
    return `Error: ${result.message}\n${captured}\n`;
}

type ExecSyncError = Error & {
    readonly status?: number | null;
    readonly signal?: string | null;
    readonly stdout?: string;
    readonly message: string;
};

function isExecSyncError(error: unknown): error is ExecSyncError {
    return error instanceof Error && 'status' in error;
}

function bashFailureMessage(error: unknown): string {
    if (isExecSyncError(error)) {
        if (error.signal === 'SIGTERM') {
            return `command timed out after ${bashTimeoutMs} ms`;
        }
        if (typeof error.status === 'number') {
            return `command exited with status ${error.status}`;
        }
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

function bashCapturedOutput(error: unknown): string {
    if (isExecSyncError(error) && typeof error.stdout === 'string') {
        return error.stdout;
    }
    return '';
}
