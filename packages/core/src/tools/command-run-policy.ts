import { commandRunFailure } from './command-run-errors.js';

export const COMMAND_RUN_POLICY_PROFILES = ['fixed-harness'] as const;
export type CommandRunPolicyProfile = (typeof COMMAND_RUN_POLICY_PROFILES)[number];
export const defaultCommandRunPolicyProfile: CommandRunPolicyProfile = 'fixed-harness';

const FIXED_HARNESS_COMMAND = ['node', '--eval', "console.log('mission-control command.run harness ok')"] as const;

const SAFE_NO_ARG_COMMANDS = ['pwd', 'whoami', 'hostname'] as const;

const ALLOWED_COMMANDS_BY_PROFILE: Record<CommandRunPolicyProfile, readonly (readonly string[])[]> = {
    'fixed-harness': [FIXED_HARNESS_COMMAND, ...SAFE_NO_ARG_COMMANDS.map((cmd) => [cmd] as const)],
};

/**
 * Non-throwing predicate: returns true when the command is in the safe allowlist
 * and can execute without asking the user for approval.
 *
 * Commands NOT in the allowlist are still runnable — they just go through the
 * interactive approval flow (Allow once / Always allow / Deny) before executing.
 */
export function isAllowlistedCommand(
    command: string,
    args: readonly string[],
    policyProfile: CommandRunPolicyProfile = defaultCommandRunPolicyProfile,
): boolean {
    const fullCommand = [command, ...args];
    return ALLOWED_COMMANDS_BY_PROFILE[policyProfile].some((allowed) => sameCommand(allowed, fullCommand));
}

export function allowedCommand(
    command: string,
    args: readonly string[],
    policyProfile: CommandRunPolicyProfile = defaultCommandRunPolicyProfile,
): readonly string[] {
    const fullCommand = [command, ...args];
    if (ALLOWED_COMMANDS_BY_PROFILE[policyProfile].some((allowed) => sameCommand(allowed, fullCommand))) {
        return fullCommand;
    }
    throw commandRunFailure('command_not_allowed', `command is not allowlisted: ${fullCommand.join(' ')}`);
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index]);
}
