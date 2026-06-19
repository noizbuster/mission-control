#!/usr/bin/env node

/**
 * End-to-end smoke for the expanded tool set + namespaced MCP tools through the BUILT dist
 * (todo 13 — the final implementation todo).
 *
 * Proves, against the compiled dist (not source):
 *  (a) the assembled system prompt contains `# Available tools`, `# Guidelines`,
 *      `<available_skills>`, and advertises the namespaced `mcp__fixture__echo` tool;
 *  (b) a `glob` tool call and a `mcp__fixture__echo` tool call execute and settle `completed`;
 *  (c) a deliberately broken MCP server (crash mode) yields a warning, not a hard failure
 *      — its tools are absent from the advertisement while the working server's tools remain.
 *
 * Architecture: a temp trusted workspace with a `.mcp.json` (fixture + broken server) drives
 * the real graph tool loop through the flat-provider bridge. The scripted provider
 * (`scriptedMcpToolsSmokeProvider`) proposes the glob + mcp tool calls deterministically —
 * no network, no real provider credentials, no flaky timers.
 */
import type { ChatInputEvent } from '../apps/cli/src/commands/interactive-chat-io.js';
import type { AgentEvent } from '../packages/protocol/src/index.js';
import {
    createScriptedMcpToolsCapture,
    scriptedMcpToolsSmokeProvider,
} from './coding-agent-smoke-mcp-tools-provider.ts';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootUrl = new URL('../', import.meta.url);
const fixtureServerPath = fileURLToPath(
    new URL('../packages/core/src/tools/mcp/fixtures/stdio-fixture-server.mjs', import.meta.url),
);
const evidenceDir = fileURLToPath(new URL('../.omo/evidence/', import.meta.url));
const evidencePath = join(evidenceDir, 'task-13-cli-coding-agent-skills-mcp.jsonl');

const cliArgsModule: Pick<typeof import('../apps/cli/src/args.js'), 'parseArgs'> = await import(
    new URL('./apps/cli/dist/args.js', rootUrl).href
);
const cliRunModule: Pick<typeof import('../apps/cli/src/commands/run-agent.js'), 'runAgent'> = await import(
    new URL('./apps/cli/dist/commands/run-agent.js', rootUrl).href
);
const coreModule: Pick<
    typeof import('../packages/core/src/index.js'),
    'ProjectTrustStore' | 'missionControlDataDirEnvKey'
> = await import(new URL('./packages/core/dist/index.js', rootUrl).href);

const { parseArgs } = cliArgsModule;
const { runAgent } = cliRunModule;
const { ProjectTrustStore, missionControlDataDirEnvKey } = coreModule;

const configDirEnvKey = 'MCTRL_CONFIG_DIR';
const tempRoots: string[] = [];
const capturedEvents: AgentEvent[] = [];

try {
    const dataDir = await tempRoot('mctrl-mcp-smoke-data-');
    const configDir = await tempRoot('mctrl-mcp-smoke-config-');
    const workspaceRoot = await tempRoot('mctrl-mcp-smoke-workspace-');
    const authFilePath = join(dataDir, 'auth.json');
    const sessionId = 'session_mcp_tools_smoke';
    const sessionJsonlPath = join(dataDir, 'sessions', `${sessionId}.jsonl`);

    process.env[missionControlDataDirEnvKey] = dataDir;
    process.env[configDirEnvKey] = configDir;

    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(join(workspaceRoot, 'src', 'notes.txt'), 'smoke fixture for glob\n', 'utf8');
    await initializeGitWorkspace(workspaceRoot);
    await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');

    await writeMcpConfig(workspaceRoot, fixtureServerPath);

    const capture = createScriptedMcpToolsCapture();
    const provider = scriptedMcpToolsSmokeProvider(capture, { fixtureServerName: 'fixture' });
    const chatOutput = bufferedOutput();

    const output = await runAgent(parseArgs(['--session', sessionId, '--model', 'local/local-echo']), {
        authStore: emptyAuthStore(authFilePath),
        chatInput: scriptedInput([
            { type: 'line', value: 'use glob and mcp tools to explore' },
            { type: 'line', value: 'always' },
            { type: 'interrupt' },
            { type: 'interrupt' },
        ]),
        chatOutput: chatOutput.output,
        workspaceRoot,
        provider,
        onRuntimeEvent: (event) => {
            capturedEvents.push(event);
        },
    });

    assertEvidence(capture, output, sessionJsonlPath, workspaceRoot);
    await writeEvidence(capture, output, sessionJsonlPath, dataDir, workspaceRoot);
} catch (error: unknown) {
    process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
} finally {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
}
process.exit(0);

function assertEvidence(
    capture: ReturnType<typeof createScriptedMcpToolsCapture>,
    output: string,
    sessionJsonlPath: string,
    workspaceRoot: string,
): void {
    const systemPrompt = capture.systemPrompts[0] ?? '';
    assertContains(systemPrompt, '# Available tools', 'system prompt missing # Available tools section');
    assertContains(systemPrompt, '# Guidelines', 'system prompt missing # Guidelines section');
    assertContains(systemPrompt, '<available_skills>', 'system prompt missing <available_skills> block');
    assertContains(systemPrompt, 'mcp__fixture__echo', 'system prompt missing mcp__fixture__echo advertisement');
    assertNotContains(
        systemPrompt,
        'mcp__broken__',
        'broken server tools leaked into advertisement (graceful degradation failed)',
    );

    const globCompleted = capturedEvents.some(
        (event) =>
            event.type === 'tool.completed' &&
            event.toolResult?.toolCallId === 'smoke_glob_call' &&
            event.toolResult?.status === 'completed',
    );
    if (!globCompleted) {
        throw new Error('glob tool call did not settle completed');
    }

    const mcpCompleted = capturedEvents.some(
        (event) =>
            event.type === 'tool.completed' &&
            event.toolResult?.toolCallId === 'smoke_mcp_echo_call' &&
            event.toolResult?.status === 'completed',
    );
    if (!mcpCompleted) {
        throw new Error('mcp__fixture__echo tool call did not settle completed');
    }

    if (output.length === 0) {
        throw new Error('command output was empty (possible dry-run — the built dist was not exercised)');
    }

    process.stdout.write(
        `smoke PASSED: systemPrompt has sections + mcp__fixture__echo, glob+mcp tool.completed captured, output=${output.length} chars, workspace=${workspaceRoot}, session=${sessionJsonlPath}\n`,
    );
}

async function writeEvidence(
    capture: ReturnType<typeof createScriptedMcpToolsCapture>,
    output: string,
    sessionJsonlPath: string,
    dataDir: string,
    workspaceRoot: string,
): Promise<void> {
    const systemPrompt = capture.systemPrompts[0] ?? '';
    const toolCompletedEvents = capturedEvents.filter((event) => event.type === 'tool.completed');
    const toolFailedEvents = capturedEvents.filter((event) => event.type === 'tool.failed');

    let sessionJsonlPreview = '';
    try {
        const sessionContent = await readFile(sessionJsonlPath, 'utf8');
        const lines = sessionContent.trim().split('\n');
        sessionJsonlPreview = lines.slice(-10).join('\n');
    } catch {
        sessionJsonlPreview = `<unable to read session jsonl at ${sessionJsonlPath}>`;
    }

    const evidence = {
        timestamp: new Date().toISOString(),
        command: 'pnpm smoke:coding-agent-mcp-tools',
        sessionId: 'session_mcp_tools_smoke',
        dataDir,
        workspaceRoot,
        sessionJsonlPath,
        systemPromptSections: {
            hasAvailableTools: systemPrompt.includes('# Available tools'),
            hasGuidelines: systemPrompt.includes('# Guidelines'),
            hasAvailableSkills: systemPrompt.includes('<available_skills>'),
            hasMcpFixtureEcho: systemPrompt.includes('mcp__fixture__echo'),
            hasBrokenServerTools: systemPrompt.includes('mcp__broken__'),
        },
        toolCompletedEvents: toolCompletedEvents.map((event) => ({
            type: event.type,
            toolCallId: event.toolResult?.toolCallId,
            status: event.toolResult?.status,
            outputPreview: event.toolResult?.output?.slice(0, 200),
        })),
        toolFailedEvents: toolFailedEvents.map((event) => ({
            type: event.type,
            toolCallId: event.toolResult?.toolCallId,
            status: event.toolResult?.status,
        })),
        gracefulDegradation: {
            brokenServerToolsAdvertised: systemPrompt.includes('mcp__broken__'),
            fixtureServerToolsAdvertised: systemPrompt.includes('mcp__fixture__echo'),
            runCompleted: !output.includes('Task failed') && !output.includes('run failed'),
        },
        systemPromptExcerpt: systemPrompt.slice(0, 2000),
        commandOutputExcerpt: output.slice(0, 2000),
        sessionJsonlPreview,
    };

    await mkdir(evidenceDir, { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`evidence written to ${evidencePath}\n`);
}

async function writeMcpConfig(workspaceRoot: string, fixturePath: string): Promise<void> {
    const config = {
        mcpServers: {
            fixture: {
                type: 'local',
                command: [process.execPath, fixturePath],
            },
            broken: {
                type: 'local',
                command: [process.execPath, fixturePath, 'crash'],
                timeoutMs: 3000,
            },
        },
    };
    await writeFile(join(workspaceRoot, '.mcp.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: workspaceRoot });
}

function assertContains(haystack: string, needle: string, message: string): void {
    if (!haystack.includes(needle)) {
        throw new Error(`${message} — searched for "${needle}" in ${haystack.length} chars of system prompt`);
    }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
    if (haystack.includes(needle)) {
        throw new Error(`${message} — found "${needle}" in system prompt`);
    }
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
