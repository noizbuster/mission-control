import type { CliArgs } from './args.js';

export function parseSessionArgs(argv: readonly string[]): CliArgs {
    const command = argv[0];
    switch (command) {
        case 'list':
        case 'ls':
            if (argv[1] !== undefined) {
                throw new Error(`Unsupported session list argument: ${argv[1]}`);
            }
            return createSessionArgs('session-list');
        case 'show': {
            const sessionId = argv[1];
            if (sessionId === undefined) {
                throw new Error('session show requires a session id');
            }
            if (argv[2] !== undefined) {
                throw new Error(`Unsupported session show argument: ${argv[2]}`);
            }
            return { ...createSessionArgs('session-show'), sessionId };
        }
        case 'replay': {
            const sessionId = argv[1];
            if (sessionId === undefined) {
                throw new Error('session replay requires a session id');
            }
            if (argv[2] !== '--jsonl') {
                throw new Error('session replay requires --jsonl for event output');
            }
            if (argv[3] !== undefined) {
                throw new Error(`Unsupported session replay argument: ${argv[3]}`);
            }
            return { ...createSessionArgs('session-replay'), mode: 'jsonl', sessionId };
        }
        default:
            throw new Error(`Unsupported session command: ${command ?? ''}`);
    }
}

function createSessionArgs(command: CliArgs['command']): CliArgs {
    return {
        mode: 'ink',
        useNative: undefined,
        command,
        showHelp: false,
        showVersion: false,
    };
}
