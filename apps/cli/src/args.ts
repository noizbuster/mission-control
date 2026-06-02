export type CliMode = 'ink' | 'plain' | 'json';

export type CliCommand = 'run';

export type CliArgs = {
    readonly mode: CliMode;
    readonly useNative: boolean | undefined;
    readonly command: CliCommand;
    readonly showHelp: boolean;
    readonly showVersion: boolean;
};

export const supportedCliFlags = [
    '--ui',
    '--no-tui',
    '--json',
    '--native',
    '--no-native',
    '--version',
    '--help',
] as const;

export function parseArgs(argv: readonly string[]): CliArgs {
    let mode: CliMode = 'ink';
    let useNative: boolean | undefined;
    let showHelp = false;
    let showVersion = false;
    let index = 0;

    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--ui': {
                const value = argv[index + 1];
                if (value !== 'ink') {
                    throw new Error('--ui only supports ink');
                }
                mode = 'ink';
                index += 2;
                break;
            }
            case '--no-tui':
                mode = 'plain';
                index += 1;
                break;
            case '--json':
                mode = 'json';
                index += 1;
                break;
            case '--native':
                useNative = true;
                index += 1;
                break;
            case '--no-native':
                useNative = false;
                index += 1;
                break;
            case '--version':
                showVersion = true;
                index += 1;
                break;
            case '--help':
                showHelp = true;
                index += 1;
                break;
            case undefined:
                index += 1;
                break;
            default:
                throw new Error(`Unsupported argument: ${current}`);
        }
    }

    return {
        mode,
        useNative,
        command: 'run',
        showHelp,
        showVersion,
    };
}
