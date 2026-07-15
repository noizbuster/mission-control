/**
 * `mctrl agents` CLI command surface (todo 39). Pure parser + async runner for
 * the list/show/unpack/disable/enable/import subcommands.
 *
 * The parser turns raw argv into a typed {@linkcode AgentsCliCommand} discriminated
 * union; the runner executes the command against an {@linkcode AgentIndex} and
 * the workspace's `.mctrl/agents/` directory. This module is the CLI twin of
 * {@linkcode ./agents-command.js} (the interactive `/agents` slash command) and
 * reuses that module's `formatAgentDetails` for `show` output. Disabled-state
 * persistence lives in {@linkcode ./agents-disabled-config.js}.
 */
import {
    type AgentDefinition,
    AgentIndex,
    BUNDLED_AGENT_TEMPLATES,
    discoverAgents,
    parseAgentFile,
} from '@mission-control/core';
import { formatAgentDetails } from './agents-command';
import { readDisabledSet, toggleDisabled } from './agents-disabled-config';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BUNDLED_SOURCE_PATH = '<bundled>';

const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
    'claude',
    'claude-code',
    'cursor',
    'codex',
    'gemini',
    'cline',
    'windsurf',
    'vscode',
    'copilot',
    'github-copilot',
    'opencode',
    'mctrl',
]);

/**
 * Flags accepted by `agents unpack`. Mirrors oh-my-pi parity, except mctrl keeps
 * the project directory as the default scope (oh-my-pi defaults to user).
 */
export type UnpackFlags = {
    readonly all?: boolean;
    readonly force?: boolean;
    readonly user?: boolean;
    readonly project?: boolean;
    readonly dir?: string;
    readonly json?: boolean;
};

export type AgentsCliCommand =
    | { readonly kind: 'list' }
    | { readonly kind: 'show'; readonly name: string }
    | { readonly kind: 'unpack'; readonly name?: string; readonly flags?: UnpackFlags }
    | { readonly kind: 'disable'; readonly name: string }
    | { readonly kind: 'enable'; readonly name: string }
    | { readonly kind: 'import'; readonly harness: string; readonly path: string }
    | { readonly kind: 'invalid'; readonly message: string };

/** Structured result of an unpack run; serialized to JSON when `--json` is set. */
interface UnpackResult {
    readonly targetDir: string;
    readonly total: number;
    readonly written: readonly string[];
    readonly skipped: readonly string[];
}

/**
 * Parse the argv tail that follows `mctrl agents` into an {@linkcode AgentsCliCommand}.
 * Never throws — unknown subcommands and missing/extra arguments produce
 * `{ kind: 'invalid', message }` for the runner to surface.
 */
export function parseAgentsSubcommand(args: readonly string[]): AgentsCliCommand {
    const [head, ...rest] = args;

    if (head === undefined || head === 'list' || head === 'ls') {
        if (rest.length > 0) {
            return invalid(`agents ${head ?? 'list'} does not accept arguments`);
        }
        return { kind: 'list' };
    }
    if (head === 'unpack') {
        return parseUnpackArgs(rest);
    }
    if (head === 'show' || head === 'disable' || head === 'enable') {
        const name = rest[0];
        if (name === undefined) {
            return invalid(`agents ${head} requires an agent name`);
        }
        if (rest.length > 1) {
            return invalid(`agents ${head} accepts exactly one agent name`);
        }
        return buildNamedAgentCmd(head, name);
    }
    if (head === 'import') {
        const harness = rest[0];
        const sourcePath = rest[1];
        if (harness === undefined) {
            return invalid('agents import requires a harness and a file path');
        }
        if (sourcePath === undefined) {
            return invalid('agents import requires a file path');
        }
        if (rest.length > 2) {
            return invalid('agents import accepts exactly a harness and a file path');
        }
        return { kind: 'import', harness, path: sourcePath };
    }
    return invalid(`Unknown agents subcommand: ${head}`);
}

/**
 * Parse the `agents unpack` argv tail. Walks `rest` left-to-right, collecting
 * boolean flags, a `--dir` value (space- or `=`-separated), and at most one
 * positional agent name. Returns `{ kind: 'invalid', message }` on any
 * validation violation; never throws. When no flags are present, the returned
 * command omits the `flags` key so the shape stays `{ kind:'unpack', name }`
 * for backward compatibility.
 */
function parseUnpackArgs(rest: readonly string[]): AgentsCliCommand {
    const flags: { all?: boolean; force?: boolean; user?: boolean; project?: boolean; dir?: string; json?: boolean } =
        {};
    let name: string | undefined;

    let i = 0;
    while (i < rest.length) {
        const token = rest[i];
        if (token === undefined) {
            i += 1;
            continue;
        }
        if (token === '--all') {
            flags.all = true;
        } else if (token === '--force') {
            flags.force = true;
        } else if (token === '--user') {
            flags.user = true;
        } else if (token === '--project') {
            flags.project = true;
        } else if (token === '--json') {
            flags.json = true;
        } else if (token === '--dir') {
            const next = rest[i + 1];
            if (next === undefined) {
                return invalid('agents unpack --dir requires a value');
            }
            flags.dir = next;
            i += 1;
        } else if (token.startsWith('--dir=')) {
            const value = token.slice('--dir='.length);
            if (value.length === 0) {
                return invalid('agents unpack --dir requires a value');
            }
            flags.dir = value;
        } else if (token.startsWith('--')) {
            return invalid(`agents unpack unknown flag: ${token}`);
        } else {
            if (name !== undefined) {
                return invalid('agents unpack accepts at most one agent name');
            }
            name = token;
        }
        i += 1;
    }

    if (flags.all === true && name !== undefined) {
        return invalid('agents unpack --all is mutually exclusive with an agent name');
    }
    if (flags.user === true && flags.project === true) {
        return invalid('agents unpack --user and --project are mutually exclusive');
    }
    if (flags.dir !== undefined && (flags.user === true || flags.project === true)) {
        return invalid('agents unpack --dir is mutually exclusive with --user/--project');
    }
    if (name === undefined && flags.all !== true) {
        return invalid('agents unpack requires an agent name or --all');
    }

    const hasFlags =
        flags.all !== undefined ||
        flags.force !== undefined ||
        flags.user !== undefined ||
        flags.project !== undefined ||
        flags.dir !== undefined ||
        flags.json !== undefined;

    if (!hasFlags) {
        return { kind: 'unpack', name: name as string };
    }
    if (name !== undefined) {
        return { kind: 'unpack', name, flags };
    }
    return { kind: 'unpack', flags };
}

export type AgentsCliOptions = {
    readonly workspaceRoot: string;
    readonly userConfigDir: string;
    readonly disabledConfigPath?: string;
    readonly projectAgentsDir?: string;
};

/** Execute a parsed {@linkcode AgentsCliCommand} and return stdout text. */
export async function runAgentsCliCommand(cmd: AgentsCliCommand, options: AgentsCliOptions): Promise<string> {
    switch (cmd.kind) {
        case 'list':
            return runList(options);
        case 'show':
            return runShow(cmd.name, options);
        case 'unpack':
            return runUnpack(cmd, options);
        case 'disable':
            return runDisable(cmd.name, options);
        case 'enable':
            return runEnable(cmd.name, options);
        case 'import':
            return runImport(cmd.harness, cmd.path, options);
        case 'invalid':
            return `Error: ${cmd.message}\n`;
        default:
            return assertNeverCmd(cmd);
    }
}

async function runList(options: AgentsCliOptions): Promise<string> {
    const { agents, disabled } = await loadAgentsAndDisabled(options);
    return formatAgentsCliList(agents, disabled);
}

async function runShow(name: string, options: AgentsCliOptions): Promise<string> {
    const { agents, disabled } = await loadAgentsAndDisabled(options);
    const agent = agents.find((a) => a.name === name);
    if (agent === undefined) {
        throw new Error(`Agent not found: ${name}`);
    }
    const withState: AgentDefinition = disabled.has(name) ? { ...agent, disabled: true } : agent;
    return formatAgentDetails(withState);
}

/**
 * Unpack bundled agent templates. With `--all`, writes every bundled agent
 * (skipping existing files unless `--force`). With a single name, writes that
 * one agent (current behavior; `--force` is the implicit default for single
 * name to preserve backward compatibility). `--json` serializes an
 * {@linkcode UnpackResult} instead of human text.
 *
 * Default scope is project (`<workspace>/.mctrl/agents`), matching mctrl's
 * pre-flag behavior; this differs from oh-my-pi, which defaults to user scope.
 */
async function runUnpack(
    cmd: Extract<AgentsCliCommand, { kind: 'unpack' }>,
    options: AgentsCliOptions,
): Promise<string> {
    const flags = cmd.flags ?? {};
    const result = await unpackTemplates(cmd, options, flags);
    if (flags.json === true) {
        return `${JSON.stringify(result, null, 2)}\n`;
    }
    return formatUnpackResult(result);
}

async function unpackTemplates(
    cmd: Extract<AgentsCliCommand, { kind: 'unpack' }>,
    options: AgentsCliOptions,
    flags: UnpackFlags,
): Promise<UnpackResult> {
    const targetDir = resolveUnpackTargetDir(options, flags);
    await mkdir(targetDir, { recursive: true });

    if (flags.all === true) {
        const names = listBundledTemplateNames();
        const written: string[] = [];
        const skipped: string[] = [];
        for (const templateName of names) {
            const template = findBundledTemplate(templateName);
            if (template === undefined) continue;
            const targetPath = join(targetDir, `${templateName}.md`);
            if (flags.force !== true) {
                try {
                    await stat(targetPath);
                    skipped.push(targetPath);
                    continue;
                } catch (error) {
                    if (!isENOENTError(error)) throw error;
                }
            }
            await writeFile(targetPath, template, 'utf8');
            written.push(targetPath);
        }
        return { targetDir, total: names.length, written, skipped };
    }

    const name = cmd.name;
    if (name === undefined) {
        throw new Error('agents unpack requires an agent name or --all');
    }
    const template = findBundledTemplate(name);
    if (template === undefined) {
        throw new Error(`Bundled agent not found: ${name}`);
    }
    const targetPath = join(targetDir, `${name}.md`);
    await writeFile(targetPath, template, 'utf8');
    return { targetDir, total: 1, written: [targetPath], skipped: [] };
}

/** Resolve the directory unpack writes into. Project is the default scope. */
function resolveUnpackTargetDir(options: AgentsCliOptions, flags: UnpackFlags): string {
    if (flags.dir !== undefined) {
        return resolve(options.workspaceRoot, flags.dir);
    }
    if (flags.user === true) {
        return join(options.userConfigDir, 'agents');
    }
    return options.projectAgentsDir ?? join(options.workspaceRoot, '.mctrl', 'agents');
}

function formatUnpackResult(result: UnpackResult): string {
    const lines: string[] = [`Unpacked ${result.written.length} of ${result.total} agent(s) to ${result.targetDir}`];
    for (const filePath of result.written) lines.push(`  + ${filePath}`);
    if (result.skipped.length > 0) {
        lines.push(`Skipped ${result.skipped.length} existing (use --force to overwrite):`);
        for (const filePath of result.skipped) lines.push(`  = ${filePath}`);
    }
    return `${lines.join('\n')}\n`;
}

function isENOENTError(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function runDisable(name: string, options: AgentsCliOptions): Promise<string> {
    const { agents } = await loadAgentsAndDisabled(options);
    if (!agents.some((a) => a.name === name)) {
        throw new Error(`Agent not found: ${name}`);
    }
    const outcome = await toggleDisabled(options, name, 'add');
    return outcome.alreadyDisabled ? `Agent ${name} is already disabled\n` : `Disabled ${name}\n`;
}

async function runEnable(name: string, options: AgentsCliOptions): Promise<string> {
    const outcome = await toggleDisabled(options, name, 'remove');
    return outcome.alreadyEnabled ? `Agent ${name} is already enabled\n` : `Enabled ${name}\n`;
}

async function runImport(harness: string, sourcePath: string, options: AgentsCliOptions): Promise<string> {
    if (!KNOWN_HARNESSES.has(harness)) {
        throw new Error(`Unknown harness: ${harness}. Known: ${[...KNOWN_HARNESSES].join(', ')}`);
    }
    let content: string;
    try {
        content = await readFile(sourcePath, 'utf8');
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read agent file ${sourcePath}: ${detail}`);
    }
    let agent: AgentDefinition;
    try {
        agent = parseAgentFile(sourcePath, content, 'project');
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse ${harness} agent file ${sourcePath}: ${detail}`);
    }
    const targetDir = options.projectAgentsDir ?? join(options.workspaceRoot, '.mctrl', 'agents');
    const targetPath = join(targetDir, `${agent.name}.md`);
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    return `Imported ${agent.name} (${harness}) to ${targetPath}\n`;
}

export function formatAgentsCliList(agents: readonly AgentDefinition[], disabled: ReadonlySet<string>): string {
    if (agents.length === 0) {
        return 'No agents discovered.\n';
    }
    const lines: string[] = [`Discovered agents (${agents.length}):`];
    for (const agent of agents) {
        const segments = [`[${agent.source}]`];
        const modelStr = formatAgentModel(agent.model);
        if (modelStr !== undefined) segments.push(`model: ${modelStr}`);
        if (agent.tier !== undefined) segments.push(`tier: ${agent.tier}`);
        if (disabled.has(agent.name)) segments.push('disabled');
        lines.push(`  - ${agent.name} ${segments.join(' ')}`);
    }
    return `${lines.join('\n')}\n`;
}

function formatAgentModel(model: AgentDefinition['model']): string | undefined {
    if (model === undefined) return undefined;
    if (typeof model === 'string') return model;
    return `${model.providerID}/${model.modelID}`;
}

type LoadedState = { readonly agents: readonly AgentDefinition[]; readonly disabled: ReadonlySet<string> };

async function loadAgentsAndDisabled(options: AgentsCliOptions): Promise<LoadedState> {
    const result = await discoverAgents({
        workspaceRoot: options.workspaceRoot,
        userConfigDir: options.userConfigDir,
    });
    const index = new AgentIndex(result);
    const disabled = await readDisabledSet(options);
    return { agents: index.list(), disabled };
}

function findBundledTemplate(name: string): string | undefined {
    for (const template of BUNDLED_AGENT_TEMPLATES) {
        try {
            const agent = parseAgentFile(BUNDLED_SOURCE_PATH, template, 'bundled');
            if (agent.name === name) return template;
        } catch {}
    }
    return undefined;
}

/** Return the names of every bundled agent, in declaration order. */
function listBundledTemplateNames(): string[] {
    const names: string[] = [];
    for (const template of BUNDLED_AGENT_TEMPLATES) {
        try {
            const agent = parseAgentFile(BUNDLED_SOURCE_PATH, template, 'bundled');
            names.push(agent.name);
        } catch {}
    }
    return names;
}

function invalid(message: string): AgentsCliCommand {
    return { kind: 'invalid', message };
}

function buildNamedAgentCmd(kind: 'show' | 'disable' | 'enable', name: string): AgentsCliCommand {
    switch (kind) {
        case 'show':
            return { kind: 'show', name };
        case 'disable':
            return { kind: 'disable', name };
        case 'enable':
            return { kind: 'enable', name };
    }
}

function assertNeverCmd(value: never): never {
    throw new Error(`Unexpected agents CLI command: ${String(value)}`);
}
