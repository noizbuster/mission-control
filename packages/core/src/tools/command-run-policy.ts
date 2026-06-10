import { commandRunFailure } from './command-run-errors.js';
import { isAbsolute } from 'node:path';

const EXACT_COMMANDS = [
    ['pnpm', 'test'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'build'],
    ['pnpm', 'lint'],
    ['cargo', 'test', '--manifest-path', 'native/sidecar/Cargo.toml'],
    ['cargo', 'test', '--manifest-path', ['apps', 'desktop', 'src-tauri', 'Cargo.toml'].join('/')],
] as const;

export function allowedCommand(command: string, args: readonly string[]): readonly string[] {
    const fullCommand = [command, ...args];
    if (EXACT_COMMANDS.some((allowed) => sameCommand(allowed, fullCommand))) {
        return fullCommand;
    }
    if (isVitestRun(fullCommand)) {
        return fullCommand;
    }
    throw commandRunFailure('command_not_allowed', `command is not allowlisted: ${fullCommand.join(' ')}`);
}

function isVitestRun(command: readonly string[]): boolean {
    return (
        command.length === 5 &&
        command[0] === 'pnpm' &&
        command[1] === 'exec' &&
        command[2] === 'vitest' &&
        command[3] === 'run' &&
        isSafeTestFile(command[4] ?? '')
    );
}

function isSafeTestFile(path: string): boolean {
    return (
        path.length > 0 &&
        !path.startsWith('-') &&
        !path.includes('\0') &&
        !isAbsolute(path) &&
        !path.split(/[\\/]/).includes('..') &&
        /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path)
    );
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index]);
}
