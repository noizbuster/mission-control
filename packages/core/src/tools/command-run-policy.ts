import { commandRunFailure } from './command-run-errors.js';

const ALLOWED_COMMANDS = [['node', '--eval', "console.log('mission-control command.run harness ok')"]] as const;

export function allowedCommand(command: string, args: readonly string[]): readonly string[] {
    const fullCommand = [command, ...args];
    if (ALLOWED_COMMANDS.some((allowed) => sameCommand(allowed, fullCommand))) {
        return fullCommand;
    }
    throw commandRunFailure('command_not_allowed', `command is not allowlisted: ${fullCommand.join(' ')}`);
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index]);
}
