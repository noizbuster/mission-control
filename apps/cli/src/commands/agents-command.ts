/**
 * `/agents` slash command parser and formatters (todo 6).
 *
 * Registered alongside {@linkcode parseChatLine} but not inside it: the chat
 * loop calls {@linkcode parseAgentsSlashLine} when it sees a line beginning
 * with `/agents`. The parser is pure and side-effect-free; the action runner
 * (separate module) consumes the {@linkcode AgentsCommand} discriminated
 * union and performs the actual list/show/reload/disable work against an
 * {@linkcode AgentIndex}.
 *
 * Reserved subcommands: `reload` and `disable`. An agent literally named
 * `reload` or `disable` can only be inspected through direct registry lookup,
 * not through this slash surface.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import { splitCommandParts } from './chat-command-parts.js';

export type AgentsCommand =
    | { readonly kind: 'list' }
    | { readonly kind: 'show'; readonly name: string }
    | { readonly kind: 'reload' }
    | { readonly kind: 'disable'; readonly name: string }
    | { readonly kind: 'invalid'; readonly message: string };

const AGENTS_SLASH_HEAD = 'agents';
const SUBCOMMAND_RELOAD = 'reload';
const SUBCOMMAND_DISABLE = 'disable';

/**
 * Parse the tail that follows `/agents ` into an {@linkcode AgentsCommand}.
 *
 * Empty input produces a `list` command. `reload` and `disable <name>` are
 * reserved subcommands; any other single token is treated as an agent name
 * (`show`).
 */
export function parseAgentsCommand(input: string): AgentsCommand {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return { kind: 'list' };
    }
    if (parts.head === SUBCOMMAND_RELOAD) {
        if (parts.tail.length > 0) {
            return { kind: 'invalid', message: '/agents reload does not accept arguments' };
        }
        return { kind: 'reload' };
    }
    if (parts.head === SUBCOMMAND_DISABLE) {
        return parseDisableTail(parts.tail);
    }
    if (parts.tail.length > 0) {
        return { kind: 'invalid', message: '/agents accepts at most one agent name' };
    }
    return { kind: 'show', name: parts.head };
}

function parseDisableTail(tail: string): AgentsCommand {
    const parts = splitCommandParts(tail);
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: '/agents disable requires an agent name' };
    }
    if (parts.tail.length > 0) {
        return { kind: 'invalid', message: '/agents disable accepts exactly one agent name' };
    }
    return { kind: 'disable', name: parts.head };
}

/**
 * Try to parse a full chat line as an `/agents` slash command.
 *
 * Returns `undefined` when the line is not an `/agents` command (does not
 * start with `/agents` followed by whitespace or end-of-string). Otherwise
 * delegates to {@linkcode parseAgentsCommand} with the tail.
 */
export function parseAgentsSlashLine(line: string): AgentsCommand | undefined {
    const trimmed = line.trim();
    if (trimmed === `/${AGENTS_SLASH_HEAD}`) {
        return parseAgentsCommand('');
    }
    const prefix = `/${AGENTS_SLASH_HEAD} `;
    if (!trimmed.startsWith(prefix)) {
        return undefined;
    }
    return parseAgentsCommand(trimmed.slice(prefix.length));
}

// --- Formatters ---

/** Format a compact list of discovered agents for `/agents` output. */
export function formatAgentsList(agents: readonly AgentDefinition[]): string {
    if (agents.length === 0) {
        return 'No agents discovered.\n';
    }
    const lines: string[] = [`Discovered agents (${agents.length}):`];
    for (const agent of agents) {
        lines.push(`  - ${agent.name} [${agent.source}]${formatAgentListEntry(agent)}`);
    }
    return `${lines.join('\n')}\n`;
}

function formatAgentListEntry(agent: AgentDefinition): string {
    const segments: string[] = [];
    const model = formatAgentModel(agent.model);
    if (model !== undefined) {
        segments.push(`model: ${model}`);
    }
    if (agent.tier !== undefined) {
        segments.push(`tier: ${agent.tier}`);
    }
    return segments.length === 0 ? '' : ` ${segments.join(' ')}`;
}

/** Format detailed information for a single agent for `/agents <name>` output. */
export function formatAgentDetails(agent: AgentDefinition): string {
    const lines: string[] = [
        `Agent: ${agent.name}`,
        `  Description: ${agent.description}`,
        `  Source: ${agent.source}`,
    ];
    const model = formatAgentModel(agent.model);
    if (model !== undefined) {
        lines.push(`  Model: ${model}`);
    }
    if (agent.tier !== undefined) {
        lines.push(`  Tier: ${agent.tier}`);
    }
    if (agent.role !== undefined) {
        lines.push(`  Role: ${agent.role}`);
    }
    if (agent.tools !== undefined && agent.tools.length > 0) {
        lines.push(`  Tools: ${agent.tools.join(', ')}`);
    }
    if (agent.spawns !== undefined) {
        const spawns = agent.spawns === '*' ? '*' : agent.spawns.join(', ');
        lines.push(`  Spawns: ${spawns}`);
    }
    if (agent.thinkingLevel !== undefined) {
        lines.push(`  Thinking: ${agent.thinkingLevel}`);
    }
    if (agent.maxTurns !== undefined) {
        lines.push(`  Max turns: ${agent.maxTurns}`);
    }
    if (agent.recursion !== undefined) {
        const recursion = agent.recursion === -1 ? 'unlimited' : String(agent.recursion);
        lines.push(`  Recursion: ${recursion}`);
    }
    if (agent.filePath !== undefined) {
        lines.push(`  File: ${agent.filePath}`);
    }
    if (agent.disabled === true) {
        lines.push('  Status: disabled');
    }
    return `${lines.join('\n')}\n`;
}

function formatAgentModel(model: AgentDefinition['model']): string | undefined {
    if (model === undefined) {
        return undefined;
    }
    if (typeof model === 'string') {
        return model;
    }
    return `${model.providerID}/${model.modelID}`;
}
