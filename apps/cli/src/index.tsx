#!/usr/bin/env node
import { parseArgs } from './args.js';
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
        '  --version      Print version',
        '  --help         Print help',
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

    process.stdout.write(await runAgent(args));
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
