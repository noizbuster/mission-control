#!/usr/bin/env node

import type { ChatInputEvent } from '../apps/cli/src/commands/interactive-chat-io.js';
import type { CommandExecutionRequest, CommandExecutionResult } from '../packages/core/src/index.js';
import { approvePendingSmokePatch, scriptedCodingSmokeProvider } from './coding-agent-smoke-support.ts';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const smokeCompletionTimeoutMs = 15_000;

const { parseArgs } = await import('@mission-control/cli/args');
const { runAgent } = await import('@mission-control/cli/commands/run-agent');
const { runSessionCommand } = await import('@mission-control/cli/commands/session');
const {
    openLocalSessionEventStore,
    ProjectTrustStore,
    missionControlDataDirEnvKey,
    settleDesktopApproval,
    ensurePendingToolApprovalForCurrentBlockedRun,
} = await import('@mission-control/core');

const tempRoots: string[] = [];

try {
    const dataDir = await tempRoot('mctrl-built-dist-smoke-data-');
    const workspaceRoot = await tempRoot('mctrl-built-dist-smoke-workspace-');
    const authFilePath = join(dataDir, 'auth.json');
    const nestedRoot = join(workspaceRoot, 'nested');
    const sessionId = 'session_built_dist_smoke_coding_agent';
    const sessionDatabasePath = join(dataDir, 'mission-control.db');

    process.env[missionControlDataDirEnvKey] = dataDir;
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(nestedRoot, { recursive: true });
    await initializeGitWorkspace(workspaceRoot);
    await writeFile(join(workspaceRoot, 'src', 'message.txt'), 'alpha unique token\n', 'utf8');
    await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');

    const provider = scriptedCodingSmokeProvider();
    const chatOutput = bufferedOutput();
    const initialRunCompleted = createDeferred();
    const firstOutput = await runAgent(parseArgs(['--session', sessionId, '--model', 'local/local-echo']), {
        authStore: emptyAuthStore(authFilePath),
        chatInput: scriptedInput(
            [
                { type: 'line', value: 'inspect, edit, write, and verify' },
                { type: 'line', value: 'always' },
                { type: 'line', value: 'always' },
                { type: 'line', value: 'once' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ],
            { beforeIndex: 4, until: withTimeout(initialRunCompleted.promise, 'initial run completion') },
        ),
        chatOutput: chatOutput.output,
        workspaceRoot,
        commandExecutor: (request) => fakeBashExecutor(request, nestedRoot),
        provider,
        plainPromptGraph: 'coding-agent',
        onRuntimeEvent: (event) => {
            if (event.type === 'run.completed') {
                initialRunCompleted.resolve();
            }
        },
    });

    const blockedOutput = await runAgent(
        parseArgs([
            'run',
            'queue one blocked patch approval',
            '--jsonl',
            '--session',
            sessionId,
            '--model',
            'local/local-echo',
        ]),
        {
            authStore: emptyAuthStore(authFilePath),
            workspaceRoot,
            commandExecutor: (request) => fakeBashExecutor(request, nestedRoot),
            provider,
            plainPromptGraph: 'coding-agent',
        },
    );

    const blockedReplayOutput = (await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl'])))
        .stdout;
    const blockedReplayDiagnostics = diagnosticRecords(blockedReplayOutput);
    if (blockedReplayDiagnostics.length > 0) {
        throw new Error(`blocked replay diagnostics present: ${JSON.stringify(blockedReplayDiagnostics)}`);
    }

    await approvePendingSmokePatch(
        { dataDir, sessionId, workspaceRoot, toolCallId: 'smoke_patch_call' },
        {
            openStore: async ({ dataDir: openDataDir, sessionId: openSessionId, now, createEventId }) =>
                openLocalSessionEventStore({
                    dataDir: openDataDir,
                    sessionId: openSessionId,
                    now,
                    createEventId,
                }),
            ensurePendingApproval: ensurePendingToolApprovalForCurrentBlockedRun,
            settleApproval: async (input, options) => settleDesktopApproval(input, options),
        },
    );

    const resumedRunCompleted = createDeferred();
    const resumedOutput = await runAgent(parseArgs(['--session', sessionId, '--model', 'local/local-echo']), {
        authStore: emptyAuthStore(authFilePath),
        chatInput: scriptedInput([{ type: 'line', value: '/continue' }, { type: 'interrupt' }, { type: 'interrupt' }], {
            beforeIndex: 1,
            until: withTimeout(resumedRunCompleted.promise, 'resumed run completion'),
        }),
        chatOutput: bufferedOutput().output,
        workspaceRoot,
        commandExecutor: (request) => fakeBashExecutor(request, nestedRoot),
        provider,
        plainPromptGraph: 'coding-agent',
        onRuntimeEvent: (event) => {
            if (event.type === 'run.completed' && event.run?.command === 'resume') {
                resumedRunCompleted.resolve();
            }
        },
    });

    const replayOutput = (await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']))).stdout;
    const replayDiagnostics = diagnosticRecords(replayOutput);
    if (replayDiagnostics.length > 0) {
        throw new Error(`replay diagnostics present: ${JSON.stringify(replayDiagnostics)}`);
    }
    if (
        firstOutput.includes('Task failed') ||
        firstOutput.includes('run failed') ||
        blockedOutput.includes('task.failed')
    ) {
        throw new Error('blocked approval was rendered as a task failure');
    }
    if (!resumedOutput.includes('Assistant: smoke resumed after approval')) {
        throw new Error('resumed approval did not reach the final provider continuation');
    }
    if (replayOutput.includes('"type":"task.failed"')) {
        throw new Error('resumed replay contains task.failed');
    }
    if (!hasResumedProviderContinuation(replayOutput)) {
        throw new Error('resumed provider message was not classified as a continuation');
    }

    process.stdout.write(
        `${JSON.stringify(
            {
                command: 'pnpm smoke:coding-agent-built-dist',
                sessionId,
                dataDir,
                workspaceRoot,
                authFilePath,
                sessionDatabasePath,
                blockedReplayDiagnostics,
                replayDiagnostics,
                editedFile: await readFile(join(workspaceRoot, 'src', 'message.txt'), 'utf8'),
                createdFile: await readFile(join(workspaceRoot, 'nested', 'generated.txt'), 'utf8'),
                approvedFile: await readFile(join(workspaceRoot, '.smoke-approved.txt'), 'utf8'),
                firstOutput,
                blockedOutput,
                resumedOutput,
                blockedReplayPreview: tailLines(blockedReplayOutput),
                replayPreview: tailLines(replayOutput),
            },
            null,
            2,
        )}\n`,
    );
} finally {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
}

function emptyAuthStore(authFilePath: string) {
    return {
        authFilePath,
        readAuthFile: async () => ({ $schema: 'https://mission-control.dev/auth.schema.json', credentials: {} }),
        saveCredential: async () => undefined,
        setDefaultSelection: async () => undefined,
        deleteCredential: async () => undefined,
        listCredentialSummaries: async () => [],
        getDefaultSelection: async () => undefined,
        getModelRoles: async () => ({}),
        setModelRole: async () => undefined,
        clearModelRole: async () => undefined,
    };
}

function scriptedInput(
    events: readonly ChatInputEvent[],
    wait?: { readonly beforeIndex: number; readonly until: Promise<void> },
) {
    let index = 0;
    return {
        read: async () => {
            if (wait !== undefined && index === wait.beforeIndex) {
                await wait.until;
            }
            const event = events[index] ?? { type: 'interrupt' as const };
            index += 1;
            return event;
        },
        close: () => undefined,
    };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    if (resolve === undefined) {
        throw new Error('deferred initialization failed');
    }
    return { promise, resolve };
}

function withTimeout(promise: Promise<void>, label: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(`${label} exceeded ${smokeCompletionTimeoutMs}ms`));
        }, smokeCompletionTimeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    });
}

function bufferedOutput() {
    const chunks: string[] = [];
    return {
        output: {
            write(text: string) {
                chunks.push(text);
            },
            getOutput() {
                return chunks.join('');
            },
        },
    };
}

async function fakeBashExecutor(
    request: CommandExecutionRequest,
    expectedCwd: string,
): Promise<CommandExecutionResult> {
    if (request.command !== 'pwd' || request.cwd !== expectedCwd || request.args.length !== 0) {
        throw new Error(`unexpected bash executor request: ${JSON.stringify(request)}`);
    }
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${expectedCwd}\n`,
        stderr: '',
        durationMs: 1,
    };
}

async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: workspaceRoot });
}

function diagnosticRecords(output: string): readonly unknown[] {
    return output
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .flatMap((line) => {
            const value = JSON.parse(line) as { readonly kind?: string; readonly diagnostic?: unknown };
            return value.kind === 'diagnostic' ? [value.diagnostic] : [];
        });
}

function hasResumedProviderContinuation(output: string): boolean {
    return output
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .some((line) => {
            const value = JSON.parse(line) as {
                readonly kind?: string;
                readonly step?: { readonly kind?: string; readonly message?: string; readonly continuation?: boolean };
            };
            return (
                value.kind === 'coding.step' &&
                value.step?.kind === 'provider.message' &&
                value.step.message === 'smoke resumed after approval' &&
                value.step.continuation === true
            );
        });
}

function tailLines(output: string): readonly string[] {
    return output
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .slice(-12);
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
