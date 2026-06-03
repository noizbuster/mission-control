#!/usr/bin/env node
import { parseArgs } from './args.js';
import { runAuthCommand } from './commands/auth.js';
import { runModelsCommand } from './commands/models.js';
import { runAgent } from './commands/run-agent.js';
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
        '',
        'Options:',
        '  --ui ink       Use Ink UI output',
        '  --no-tui       Use plain text output',
        '  --json         Emit JSON Lines events',
        '  --native       Try the Rust sidecar',
        '  --no-native    Force mock sidecar',
        '  --provider <id>  Select provider for the demo run',
        '  --model <id>     Select model, or use provider/model shorthand',
        '  --version      Print version',
        '  --help         Print help',
        '',
        'Examples:',
        '  mctrl --no-tui --provider mock --model mission-control-fast',
        '  mctrl auth login --provider mock --api-key <key>',
        '  mctrl auth list',
        '  mctrl auth logout --provider mock',
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
