import { resolveMissionControlDataDir } from '@mission-control/core';
import { parseArgs } from './args';
import type { CliCommandResult } from './cli-command-result';
import { getVersion } from './cli-version';
import { runAuthCommand } from './commands/auth';
import { runMcpCommand } from './commands/mcp';
import { disposeAllMissionControlServices } from './commands/mission-control-services';
import { runModelsCommand } from './commands/models';
import { runAgent } from './commands/run-agent';
import { runAgentsCommand } from './commands/run-agents-cli';
import { runSessionCommand } from './commands/session';
import { installCrashGuard } from './crash-guard';
import { SessionCliUsageError } from './session-args';
import { pathToFileURL } from 'node:url';

export { getVersion } from './cli-version';

export function createHelpText(): string {
    return [
        'mission-control',
        '',
        'Usage:',
        '  mc [options]',
        '  mc opens an interactive chat prompt; press Ctrl+C twice or /exit to exit.',
        '  mctrl remains available as an alias.',
        '',
        'Options:',
        '  --no-tui       Use plain text output',
        '  --json         Emit legacy JSON Lines events',
        '  --jsonl        Emit JSON Lines events and persist a replayable session',
        '  --native       Try the Rust sidecar',
        '  --no-native    Force mock sidecar',
        '  --provider <id>  Select provider for the demo run',
        '  --model <id>     Select model, or use provider/model#variant shorthand',
        '  --graph <path>   Run an authorable ABG graph JSON file',
        '  --session <id>   Reuse or create a replayable session id',
        '  --method <id>    Select auth login method',
        '  --profile <name>  Select a user-scope config profile (replaces config.json; long-only)',
        '  --thinking     Show reasoning/thinking blocks in non-interactive output',
        '  --version      Print version',
        '  --help         Print help',
        '',
        'Interactive chat commands:',
        '  /model                 Open the model and variant picker',
        '  /model <provider>/<model>[#variant]  Select the model for this chat session',
        '  /new [session-id]      Start a new durable session and switch chat to it',
        '  /session <session-id>  Switch chat to an existing durable session',
        '  /sessions              List durable sessions and lock status',
        '  /tree                  Show the durable session tree and active leaf',
        '  /branch <entry-id>     Switch the active branch leaf to a tree entry',
        '  /branch <message-id> <prompt>  Continue from a parent message in a new branch',
        '  /fork <entry-id> [session-id]  Fork a durable session from a tree entry',
        '  /clone [session-id]    Clone the current durable session into a new session',
        '  /compact [instructions]  Summarize older session history (optional focus text)',
        '  /resume                Attach to the most recent session without starting work',
        '  /continue              Resume approval-blocked or interrupted checkpoint work',
        '  /trust                 Trust this workspace for project-local resources',
        '  /trust status          Show this workspace trust decision',
        '  /trust deny            Deny project-local resources for this workspace',
        '  /trust reset           Reset this workspace trust decision',
        '  /exit                  Stop active runs and exit',
        '  /agents                Open the agent control dashboard',
        '  /agents list           Print the discovered-agents list as text',
        '  $<skill> [args]        Load a skill SKILL.md body as the next user prompt',
        '  $ skill invocations load real SKILL.md skills inside Mission Control',
        '  #<workflow-name> {prompt}  Invoke a named workflow with the given prompt',
        '  # workflows are discovered from .mctrl/workflows, .agents/workflows, and the config dir; #default is the fallback',
        '',
        'Coding-agent tools (effectful tools require approval):',
        '  repo.read / read       Read a text file inside the workspace',
        '  repo.list / ls         List directory entries inside the workspace',
        '  repo.search / grep / find  Search text files inside the workspace',
        '  file.edit              Replace exact text in an existing file (trusted + approval)',
        '  file.write             Create or replace a file (trusted + approval)',
        '  file.patch             Apply unified diffs (approval)',
        '  command.run            Run allowlisted verification commands (approval)',
        '  bash.run               Run trusted non-interactive bash (trusted + approval)',
        '',
        'Examples:',
        '  mc',
        '  mc --no-tui --provider local --model local-echo',
        '  mc --json --graph examples/abg/research-answer.graph.json --model local/local-echo#fast',
        '  mc run "summarize this repository" --session session_demo --jsonl',
        '  mc graph run examples/abg/research-answer.graph.json --session session_graph --jsonl',
        '  mc session list',
        '  mc session status [session-id]',
        '  mc session show session_demo',
        '  mc session export session_demo /tmp/session_demo.mctrl-session.json',
        '  mc session import /tmp/session_demo.mctrl-session.json',
        '  mc session replay session_demo --jsonl',
        '  mc session stop session_demo [--only | --child-only] [--timeout 15s]',
        '  mc session delete session_demo',
        '  mc session delete session_demo --expected-tree-token <sha256>',
        '  mc auth login --provider local --api-key <key>',
        '  mc auth login --provider anthropic --api-key <key>',
        '  mc auth login --provider openai --method oauth-headless',
        '  mc auth login --provider github-copilot --method oauth',
        '  mc auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
        '  --credential FIELD=VALUE',
        '  mc auth list',
        '  mc auth logout --provider local',
        '  mc models local',
        '  mc mcp list',
        '  mc mcp add <name> --type local --command <bin> [--command <arg>...] [--env KEY=VAL ...] [--scope project|user]',
        '  mc mcp add <name> --type remote --url <url> [--header KEY=VAL ...] [--scope project|user]',
        '  mc mcp remove <name> [--scope project|user]',
        '  mc mcp test <name>',
        '',
        'Agents:',
        '  mc agents list                      List discovered agents (sources, models, tiers)',
        '  mc agents show <name>               Show full details for one agent',
        '  mc agents unpack [--all] [<name>] [--force] [--user|--project|--dir <p>] [--json]  Copy bundled agents to .mctrl/agents/',
        '  mc agents disable <name>            Hide an agent from discovery',
        '  mc agents enable <name>             Re-enable a disabled agent',
        '  mc agents import <harness> <p>      Import a harness agent file to .mctrl/agents/',
    ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<CliCommandResult | undefined> {
    const args = parseArgs(argv);
    if (args.showVersion) {
        process.stdout.write(`${getVersion()}\n`);
        return;
    }
    if (args.showHelp) {
        process.stdout.write(`${args.helpText ?? createHelpText()}\n`);
        return;
    }

    switch (args.command) {
        case 'auth-login':
        case 'auth-list':
        case 'auth-logout':
            process.stdout.write(await runAuthCommand(args));
            return;
        case 'models':
            process.stdout.write(await runModelsCommand(args));
            return;
        case 'session-list':
        case 'session-status':
        case 'session-show':
        case 'session-export':
        case 'session-import':
        case 'session-replay':
        case 'session-delete':
        case 'session-stop':
            return runSessionCommand(args);
        case 'mcp-add':
        case 'mcp-list':
        case 'mcp-remove':
        case 'mcp-test':
            process.stdout.write(await runMcpCommand(args));
            return;
        case 'run':
            process.stdout.write(await runAgent(args));
            return;
        case 'agents':
            process.stdout.write(await runAgentsCommand(args));
            return;
        default:
            assertNever(args.command);
    }
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    installCrashGuard({ dataDir: resolveMissionControlDataDir() });
    try {
        const result = await main(argv);
        if (result !== undefined) writeCliCommandResult(result);
    } catch (error: unknown) {
        if (error instanceof SessionCliUsageError) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 2;
        } else if (error instanceof Error) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        } else {
            process.stderr.write(`${String(error)}\n`);
            process.exitCode = 1;
        }
    } finally {
        await disposeAllMissionControlServices().catch(() => {});
    }
}

export function writeCliCommandResult(result: CliCommandResult): void {
    if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
}

function isCliEntrypoint(): boolean {
    const entryPath = process.argv[1];
    return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isCliEntrypoint()) {
    await runCli();
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI command: ${String(value)}`);
}
