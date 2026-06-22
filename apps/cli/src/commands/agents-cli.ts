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
import { formatAgentDetails } from './agents-command.js';
import { readDisabledSet, toggleDisabled } from './agents-disabled-config.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export type AgentsCliCommand =
    | { readonly kind: 'list' }
    | { readonly kind: 'show'; readonly name: string }
    | { readonly kind: 'unpack'; readonly name: string }
    | { readonly kind: 'disable'; readonly name: string }
    | { readonly kind: 'enable'; readonly name: string }
    | { readonly kind: 'import'; readonly harness: string; readonly path: string }
    | { readonly kind: 'invalid'; readonly message: string };

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
    if (head === 'show' || head === 'unpack' || head === 'disable' || head === 'enable') {
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
            return runUnpack(cmd.name, options);
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

async function runUnpack(name: string, options: AgentsCliOptions): Promise<string> {
    const template = findBundledTemplate(name);
    if (template === undefined) {
        throw new Error(`Bundled agent not found: ${name}`);
    }
    const targetDir = options.projectAgentsDir ?? join(options.workspaceRoot, '.mctrl', 'agents');
    const targetPath = join(targetDir, `${name}.md`);
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, template, 'utf8');
    return `Unpacked ${name} to ${targetPath}\n`;
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

function invalid(message: string): AgentsCliCommand {
    return { kind: 'invalid', message };
}

function buildNamedAgentCmd(kind: 'show' | 'unpack' | 'disable' | 'enable', name: string): AgentsCliCommand {
    switch (kind) {
        case 'show':
            return { kind: 'show', name };
        case 'unpack':
            return { kind: 'unpack', name };
        case 'disable':
            return { kind: 'disable', name };
        case 'enable':
            return { kind: 'enable', name };
    }
}

function assertNeverCmd(value: never): never {
    throw new Error(`Unexpected agents CLI command: ${String(value)}`);
}
