import {
    AgentIndex,
    bustSkillCache,
    discoverAgents,
    discoverSkills,
    resolveUserConfigDir,
} from '@mission-control/core';
import type { AgentDefinition, ModelProviderSelection } from '@mission-control/protocol';
import type { DashboardAgentEntry } from '@mission-control/tui/state';
import { assertUnreachable } from '../assert-unreachable';
import { type AgentsCommand, formatAgentDetails, formatAgentsList } from './agents-command';
import { readDisabledSet, toggleDisabled } from './agents-disabled-config';
import { readOverridesMap } from './agents-model-overrides-config';
import type { SkillsCommand } from './chat-commands';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';

export async function runAgentsAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
    command: AgentsCommand,
): Promise<ChatActionResult> {
    if (coding.workspaceRoot === undefined) {
        chatOutput.write('Agents command unavailable: workspace root is unavailable\n');
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'invalid') {
        chatOutput.write(`${command.message}\n`);
        return actionResult(selection, coding.activeTurn);
    }
    const workspaceRoot = coding.workspaceRoot;
    const userConfigDir = resolveUserConfigDir();
    if (command.kind === 'dashboard') {
        if (!coding.useTui || coding.openAgentsDashboard === undefined) {
            chatOutput.write(formatAgentsList(await loadDiscoveredAgents(workspaceRoot, userConfigDir)));
            return actionResult(selection, coding.activeTurn);
        }
        const entries = await loadDashboardAgentEntries(workspaceRoot, userConfigDir);
        if (entries.length === 0) chatOutput.write('No agents discovered.\n');
        else coding.openAgentsDashboard(entries);
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'list') {
        chatOutput.write(formatAgentsList(await loadDiscoveredAgents(workspaceRoot, userConfigDir)));
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'show') {
        const agent = (await loadDiscoveredAgents(workspaceRoot, userConfigDir)).find(
            (candidate) => candidate.name === command.name,
        );
        chatOutput.write(agent === undefined ? `Agent not found: ${command.name}\n` : formatAgentDetails(agent));
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'reload') {
        bustSkillCache();
        const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
        chatOutput.write(`Reloaded ${agents.length} agent${agents.length === 1 ? '' : 's'}.\n`);
        await refreshAgentsDashboardIfOpen(coding, workspaceRoot, userConfigDir);
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'disable') {
        const exists = (await loadDiscoveredAgents(workspaceRoot, userConfigDir)).some(
            (agent) => agent.name === command.name,
        );
        if (!exists) chatOutput.write(`Agent not found: ${command.name}\n`);
        else {
            await toggleDisabled({ workspaceRoot }, command.name, 'add');
            chatOutput.write(`Disabled agent: ${command.name}\n`);
            await refreshAgentsDashboardIfOpen(coding, workspaceRoot, userConfigDir);
        }
        return actionResult(selection, coding.activeTurn);
    }
    return assertUnreachable(command, 'agents command');
}

export async function runSkillsAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
    command: SkillsCommand,
): Promise<ChatActionResult> {
    if (coding.workspaceRoot === undefined) {
        chatOutput.write('Skills command unavailable: workspace root is unavailable\n');
        return actionResult(selection, coding.activeTurn);
    }
    if (command.kind === 'invalid') {
        chatOutput.write(`${command.message}\n`);
        return actionResult(selection, coding.activeTurn);
    }
    bustSkillCache();
    const { skills } = await discoverSkills({
        workspaceRoot: coding.workspaceRoot,
        userConfigDir: resolveUserConfigDir(),
    });
    coding.onSkillsReloaded?.(skills);
    chatOutput.write(`Reloaded ${skills.length} skill${skills.length === 1 ? '' : 's'}.\n`);
    return actionResult(selection, coding.activeTurn);
}

export async function loadDashboardAgentEntries(
    workspaceRoot: string,
    userConfigDir: string,
): Promise<DashboardAgentEntry[]> {
    const result = await discoverAgents({ workspaceRoot, userConfigDir });
    const disabled = await readDisabledSet({ workspaceRoot });
    const overrides = await readOverridesMap({ workspaceRoot });
    return new AgentIndex(result).list().map((agent) => {
        const model = formatDashboardModel(agent.model);
        const overrideModel = overrides.get(agent.name);
        return {
            name: agent.name,
            description: agent.description,
            source: agent.source,
            disabled: disabled.has(agent.name),
            ...(model !== undefined ? { model } : {}),
            ...(agent.tier !== undefined ? { tier: agent.tier } : {}),
            ...(overrideModel !== undefined ? { overrideModel } : {}),
            ...(agent.filePath !== undefined ? { filePath: agent.filePath } : {}),
        };
    });
}

async function loadDiscoveredAgents(workspaceRoot: string, userConfigDir: string): Promise<readonly AgentDefinition[]> {
    return new AgentIndex(await discoverAgents({ workspaceRoot, userConfigDir })).list();
}

async function refreshAgentsDashboardIfOpen(
    coding: CodingActionContext,
    workspaceRoot: string,
    userConfigDir: string,
): Promise<void> {
    if (coding.reloadAgentsDashboard !== undefined)
        coding.reloadAgentsDashboard(await loadDashboardAgentEntries(workspaceRoot, userConfigDir));
}

function formatDashboardModel(model: AgentDefinition['model']): string | undefined {
    if (model === undefined) return undefined;
    return typeof model === 'string' ? model : `${model.providerID}/${model.modelID}`;
}
