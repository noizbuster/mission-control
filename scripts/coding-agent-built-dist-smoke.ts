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
const rootUrl = new URL('../', import.meta.url);

const cliArgsModule: Pick<typeof import('../apps/cli/src/args.js'), 'parseArgs'> = await import(
    new URL('./apps/cli/dist/args.js', rootUrl).href
);
const cliRunModule: Pick<typeof import('../apps/cli/src/commands/run-agent.js'), 'runAgent'> = await import(
    new URL('./apps/cli/dist/commands/run-agent.js', rootUrl).href
);
const cliSessionModule: Pick<typeof import('../apps/cli/src/commands/session.js'), 'runSessionCommand'> = await import(
    new URL('./apps/cli/dist/commands/session.js', rootUrl).href
);
const coreModule: Pick<
    typeof import('../packages/core/src/index.js'),
    'JsonlSessionEventStore' | 'ProjectTrustStore' | 'missionControlDataDirEnvKey' | 'settleDesktopApproval'
> = await import(new URL('./packages/core/dist/index.js', rootUrl).href);

const { parseArgs } = cliArgsModule;
const { runAgent } = cliRunModule;
const { runSessionCommand } = cliSessionModule;
const { JsonlSessionEventStore, ProjectTrustStore, missionControlDataDirEnvKey, settleDesktopApproval } = coreModule;

const tempRoots: string[] = [];

try {
    const dataDir = await tempRoot('mctrl-built-dist-smoke-data-');
    const workspaceRoot = await tempRoot('mctrl-built-dist-smoke-workspace-');
    const authFilePath = join(dataDir, 'auth.json');
    const nestedRoot = join(workspaceRoot, 'nested');
    const sessionId = 'session_built_dist_smoke_coding_agent';
    const sessionJsonlPath = join(dataDir, 'sessions', `${sessionId}.jsonl`);

    process.env[missionControlDataDirEnvKey] = dataDir;
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(nestedRoot, { recursive: true });
    await initializeGitWorkspace(workspaceRoot);
    await writeFile(join(workspaceRoot, 'src', 'message.txt'), 'alpha unique token\n', 'utf8');
    await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');

    const provider = scriptedCodingSmokeProvider();
    const chatOutput = bufferedOutput();
    const firstOutput = await runAgent(parseArgs(['--session', sessionId, '--model', 'local/local-echo']), {
        authStore: emptyAuthStore(authFilePath),
        chatInput: scriptedInput([
            { type: 'line', value: 'inspect, edit, write, verify, then queue one blocked approval' },
            { type: 'line', value: 'always' },
            { type: 'line', value: 'always' },
            { type: 'line', value: 'once' },
            { type: 'line', value: 'deny' },
            { type: 'interrupt' },
            { type: 'interrupt' },
        ]),
        chatOutput: chatOutput.output,
        workspaceRoot,
        commandExecutor: (request) => fakeBashExecutor(request, nestedRoot),
        provider,
    });

    const blockedReplayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
    const blockedReplayDiagnostics = diagnosticRecords(blockedReplayOutput);
    if (blockedReplayDiagnostics.length > 0) {
        throw new Error(`blocked replay diagnostics present: ${JSON.stringify(blockedReplayDiagnostics)}`);
    }

    await approvePendingSmokePatch(
        { dataDir, sessionId, workspaceRoot, toolCallId: 'smoke_patch_call' },
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

    const resumedOutput = await runAgent(parseArgs(['--session', sessionId, '--model', 'local/local-echo']), {
        authStore: emptyAuthStore(authFilePath),
        chatInput: scriptedInput([{ type: 'line', value: '/resume' }, { type: 'interrupt' }, { type: 'interrupt' }]),
        chatOutput: bufferedOutput().output,
        workspaceRoot,
        commandExecutor: (request) => fakeBashExecutor(request, nestedRoot),
        provider,
    });

    const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
    const replayDiagnostics = diagnosticRecords(replayOutput);
    if (replayDiagnostics.length > 0) {
        throw new Error(`replay diagnostics present: ${JSON.stringify(replayDiagnostics)}`);
    }
    if (firstOutput.includes('Task failed') || firstOutput.includes('run failed')) {
        throw new Error('blocked approval was rendered as a task failure');
    }

    process.stdout.write(
        `${JSON.stringify(
            {
                command: 'pnpm smoke:coding-agent-built-dist',
                sessionId,
                dataDir,
                workspaceRoot,
                authFilePath,
                sessionJsonlPath,
                blockedReplayDiagnostics,
                replayDiagnostics,
                editedFile: await readFile(join(workspaceRoot, 'src', 'message.txt'), 'utf8'),
                createdFile: await readFile(join(workspaceRoot, 'nested', 'generated.txt'), 'utf8'),
                approvedFile: await readFile(join(workspaceRoot, '.smoke-approved.txt'), 'utf8'),
                firstOutput,
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
    };
}

function scriptedInput(events: readonly ChatInputEvent[]) {
    let index = 0;
    return {
        read: async () => {
            const event = events[index] ?? { type: 'interrupt' as const };
            index += 1;
            return event;
        },
        close: () => undefined,
    };
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
