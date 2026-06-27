import { expect } from 'vitest';
import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    JsonlSessionEventStore,
    ProjectTrustStore,
    type ProviderTurnRequest,
    settleDesktopApproval,
} from '../packages/core/src/index.js';
import {
    approvePendingSmokePatch as approvePendingSmokePatchShared,
    scriptedCodingSmokeProvider,
} from '../scripts/coding-agent-smoke-support.js';
import { parseCodingStepLines, parseDiagnosticLines, parseEventLines } from './coding-agent-smoke-replay-support.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const smokeSessionToolNames = [
    'read',
    'ls',
    'grep',
    'find',
    'file.edit',
    'file.write',
    'file.patch',
    'command.run',
    'bash.run',
];

export {
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
    sessionStartedEvent,
} from './coding-agent-smoke-fixtures.ts';
export { scriptedCodingSmokeProvider };

export async function fakeBashExecutor(
    request: CommandExecutionRequest,
    expectedCwd: string,
): Promise<CommandExecutionResult> {
    expect(request.command).toBe('pwd');
    expect(request.args).toEqual([]);
    expect(request.cwd).toBe(expectedCwd);
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${expectedCwd}\n`,
        stderr: '',
        durationMs: 1,
    };
}

export async function approvePendingSmokePatch(
    dataDir: string,
    sessionId: string,
    workspaceRoot: string,
    toolCallId: string,
): Promise<void> {
    await approvePendingSmokePatchShared(
        {
            dataDir,
            sessionId,
            workspaceRoot,
            toolCallId,
        },
        {
            openStore: async ({ dataDir: openDataDir, sessionId: openSessionId, now, createEventId }) =>
                JsonlSessionEventStore.open({
                    dataDir: openDataDir,
                    sessionId: openSessionId,
                    now,
                    createEventId,
                }),
            settleApproval: async (input, options) => settleDesktopApproval(input, options),
        },
    );
}

export async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: workspaceRoot });
}

export async function initializeTrustedSmokeWorkspace(dataDir: string, workspaceRoot: string): Promise<string> {
    const workspaceNestedRoot = join(workspaceRoot, 'nested');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(workspaceNestedRoot, { recursive: true });
    await initializeGitWorkspace(workspaceRoot);
    await writeFile(join(workspaceRoot, 'src', 'message.txt'), 'alpha unique token\n', 'utf8');
    await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');
    return workspaceNestedRoot;
}

type SmokeBlockedRunAssertions = {
    readonly firstOutput: string;
    readonly workspaceNestedRoot: string;
    readonly providerRequests: readonly ProviderTurnRequest[];
    readonly blockedReplayOutput: string;
    readonly blockedJsonlContents: string;
};

export function expectBlockedSmokeRunArtifacts(input: SmokeBlockedRunAssertions): void {
    const blockedReplayEvents = parseEventLines(input.blockedReplayOutput);
    const blockedReplayDiagnostics = parseDiagnosticLines(input.blockedReplayOutput);

    expect(input.firstOutput).toContain('Applied edit: src/message.txt (1 occurrence)');
    expect(input.firstOutput).toContain('Created file: nested/generated.txt');
    expect(input.firstOutput).toContain('Command output for bash.run');
    expect(input.firstOutput).toContain(`stdout:\n${input.workspaceNestedRoot}`);
    expect(input.firstOutput).toContain(
        'Run blocked (resumable): approval_denied: interactive CLI approval. Resume with /continue.',
    );
    expect(input.firstOutput).not.toContain('Task failed');
    expect(input.firstOutput).not.toContain('run failed');
    expect(input.providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual(smokeSessionToolNames);
    expect(blockedReplayEvents.some((event) => event.type === 'task.failed')).toBe(false);
    expect(blockedReplayEvents).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                type: 'run.blocked',
                run: expect.objectContaining({ state: 'blocked_on_approval', toolCallId: 'smoke_patch_call' }),
            }),
            expect.objectContaining({
                type: 'permission.requested',
                permissionRequest: expect.objectContaining({ id: 'permission_smoke_patch_call' }),
            }),
            expect.objectContaining({ type: 'permission.replied' }),
            expect.objectContaining({
                type: 'approval.requested',
                approvalRecord: expect.objectContaining({
                    approvalId: 'approval_permission_smoke_patch_call',
                    requestId: 'permission_smoke_patch_call',
                    state: 'pending',
                }),
            }),
            expect.objectContaining({ type: 'tool.failed', taskId: 'smoke_patch_call' }),
        ]),
    );
    expect(blockedReplayDiagnostics).toEqual([]);
    expect(input.blockedJsonlContents).toContain('smoke_bash_call');
}

type SmokeResumedRunAssertions = {
    readonly blockedJsonlContents: string;
    readonly resumedOutput: string;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly replayOutput: string;
    readonly resumedJsonlContents: string;
};

export async function expectResumedSmokeRunArtifacts(input: SmokeResumedRunAssertions): Promise<void> {
    const replayEvents = parseEventLines(input.replayOutput);
    const replaySteps = parseCodingStepLines(input.replayOutput);
    const replayDiagnostics = parseDiagnosticLines(input.replayOutput);

    expect(input.resumedOutput).toContain(`Resuming blocked run for ${input.sessionId}`);
    expect(input.resumedOutput).toContain('Assistant: smoke resumed after approval');
    expect(await readFile(join(input.workspaceRoot, 'src', 'message.txt'), 'utf8')).toBe('alpha edited token\n');
    expect(await readFile(join(input.workspaceRoot, 'nested', 'generated.txt'), 'utf8')).toBe('created by smoke\n');
    expect(await readFile(join(input.workspaceRoot, '.smoke-approved.txt'), 'utf8')).toBe('approved\n');
    expect(input.resumedJsonlContents.length).toBeGreaterThan(input.blockedJsonlContents.length);
    expect(replayEvents.some((event) => event.type === 'task.failed')).toBe(false);
    expect(replayDiagnostics).toEqual([]);
    expect(replayEvents).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                type: 'approval.requested',
                approvalRecord: expect.objectContaining({ state: 'pending' }),
            }),
            expect.objectContaining({ type: 'approval.updated' }),
            expect.objectContaining({ type: 'approval.resumed' }),
            expect.objectContaining({ type: 'tool.completed', taskId: 'smoke_read_call' }),
            expect.objectContaining({ type: 'tool.completed', taskId: 'smoke_edit_call' }),
            expect.objectContaining({ type: 'tool.completed', taskId: 'smoke_write_call' }),
            expect.objectContaining({ type: 'command.completed', taskId: 'smoke_bash_call' }),
            expect.objectContaining({
                type: 'run.command.received',
                run: expect.objectContaining({ command: 'resume', state: 'blocked_on_approval' }),
            }),
            expect.objectContaining({
                type: 'run.completed',
                run: expect.objectContaining({ command: 'resume', state: 'completed' }),
            }),
        ]),
    );
    expect(replaySteps).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'smoke_read_call' }),
            expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'smoke_edit_call' }),
            expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'smoke_write_call' }),
            expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'smoke_bash_call' }),
            expect.objectContaining({ kind: 'tool.result', toolCallId: 'smoke_patch_call', status: 'failed' }),
            expect.objectContaining({ kind: 'provider.message', message: 'smoke resumed after approval' }),
        ]),
    );
}
