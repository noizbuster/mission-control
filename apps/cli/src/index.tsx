#!/usr/bin/env node
import { parseArgs } from './args.js';
import { runAuthCommand } from './commands/auth.js';
import { runModelsCommand } from './commands/models.js';
import { runAgent } from './commands/run-agent.js';
import { runSessionCommand } from './commands/session.js';
import { pathToFileURL } from 'node:url';

export function getVersion(): string {
    return '0.1.0';
}

export function createHelpText(): string {
    return [
        'mission-control',
        '',
        'Usage:',
        '  mctrl [options]',
        '  mctrl opens an interactive chat prompt; press Ctrl+C twice or /exit to exit.',
        '',
        'Options:',
        '  --ui ink       Use Ink UI output',
        '  --no-tui       Use plain text output',
        '  --json         Emit legacy JSON Lines events',
        '  --jsonl        Emit JSON Lines events and persist a replayable session log',
        '  --native       Try the Rust sidecar',
        '  --no-native    Force mock sidecar',
        '  --provider <id>  Select provider for the demo run',
        '  --model <id>     Select model, or use provider/model#variant shorthand',
        '  --graph <path>   Run an authorable ABG graph JSON file',
        '  --session <id>   Reuse or create a replayable session id',
        '  --method <id>    Select auth login method',
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
        '  /compact               Summarize older session history into a durable compaction event',
        '  /trust                 Trust this workspace for project-local resources',
        '  /trust status          Show this workspace trust decision',
        '  /trust deny            Deny project-local resources for this workspace',
        '  /trust reset           Reset this workspace trust decision',
        '  /exit                  Stop active runs and exit',
        '  $<skill> [args]        Record a scaffold skill invocation',
        '  $ skill invocations are scaffolded inside Mission Control',
        '',
        'Examples:',
        '  mctrl',
        '  mctrl --no-tui --provider local --model local-echo',
        '  mctrl --json --graph examples/abg/research-answer.graph.json --model local/local-echo#fast',
        '  mctrl run "summarize this repository" --session session_demo --jsonl',
        '  mctrl graph run examples/abg/research-answer.graph.json --session session_graph --jsonl',
        '  mctrl session list',
        '  mctrl session show session_demo',
        '  mctrl session export session_demo /tmp/session_demo.mctrl-session.json',
        '  mctrl session import /tmp/session_demo.mctrl-session.json',
        '  mctrl session replay session_demo --jsonl',
        '  mctrl auth login --provider local --api-key <key>',
        '  mctrl auth login --provider anthropic --api-key <key>',
        '  mctrl auth login --provider openai --method oauth-headless',
        '  mctrl auth login --provider github-copilot --method oauth',
        '  mctrl auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
        '  --credential FIELD=VALUE',
        '  mctrl auth list',
        '  mctrl auth logout --provider local',
        '  mctrl models local',
    ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const args = parseArgs(argv);
    if (args.showVersion) {
        process.stdout.write(`${getVersion()}\n`);
        return;
    }
    if (args.showHelp) {
        process.stdout.write(`${createHelpText()}\n`);
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
        case 'session-show':
        case 'session-export':
        case 'session-import':
        case 'session-replay':
            process.stdout.write(await runSessionCommand(args));
            return;
        case 'run':
            process.stdout.write(await runAgent(args));
            return;
        default:
            assertNever(args.command);
    }
}

function isCliEntrypoint(): boolean {
    const entryPath = process.argv[1];
    return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isCliEntrypoint()) {
    await main().catch((error: unknown) => {
        if (error instanceof Error) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
            return;
        }
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
    });
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI command: ${String(value)}`);
}
