/**
 * Dispatcher entry for the `mctrl agents` command. Resolves the workspace root
 * and user config directory using the same precedence as every other CLI path,
 * parses the argv tail via {@linkcode parseAgentsSubcommand}, and executes the
 * command via {@linkcode runAgentsCliCommand}. Returns the stdout text for the
 * CLI to write.
 *
 * Workspace resolution reuses {@linkcode resolveWorkspaceRoot}
 * (`--workspace` > `MCTRL_WORKSPACE` > `detectWorkspaceRoot()` heuristic) and
 * user config resolution reuses {@linkcode resolveUserConfigDir} from
 * `@mission-control/core` so the agents command never diverges from the rest of
 * the CLI. Both resolvers are imported from their existing export sources rather
 * than reimplemented here.
 */
import { resolveUserConfigDir } from '@mission-control/core';
import type { CliArgs } from '../args.js';
import { type AgentsCliOptions, parseAgentsSubcommand, runAgentsCliCommand } from './agents-cli.js';
import { resolveWorkspaceRoot } from './run-agent.js';

export async function runAgentsCommand(args: CliArgs): Promise<string> {
    const options: AgentsCliOptions = {
        workspaceRoot: resolveWorkspaceRoot(args.workspacePath),
        userConfigDir: resolveUserConfigDir(),
    };
    const cmd = parseAgentsSubcommand(args.agentsArgv ?? []);
    return runAgentsCliCommand(cmd, options);
}
