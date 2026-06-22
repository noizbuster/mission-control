/**
 * In-memory index of discovered + programmatically registered agents, keyed by name.
 * Insertion order is preserved for stable `list()` / `names()` output.
 *
 * Registration is first-wins: a second `register()` with an already-seen name is
 * ignored and a `duplicate_name` diagnostic is queued (mirrors the loader's
 * discovery-time behavior). Purely in-memory; performs no I/O.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { AgentDiscoveryDiagnostic, DiscoverAgentsResult } from './agent-loader.js';

export class AgentIndex {
    private readonly agents = new Map<string, AgentDefinition>();
    private readonly insertionOrder: string[] = [];
    private readonly diagnosticsBuffer: AgentDiscoveryDiagnostic[] = [];

    constructor(discoveryResult?: DiscoverAgentsResult) {
        if (discoveryResult === undefined) {
            return;
        }
        for (const agent of discoveryResult.agents) {
            this.register(agent);
        }
        for (const diagnostic of discoveryResult.diagnostics) {
            this.diagnosticsBuffer.push(diagnostic);
        }
    }

    register(agent: AgentDefinition): void {
        if (this.agents.has(agent.name)) {
            this.diagnosticsBuffer.push({
                agentName: agent.name,
                severity: 'warning',
                code: 'duplicate_name',
                message: `agent '${agent.name}' already registered (first-wins)`,
            });
            return;
        }
        this.agents.set(agent.name, agent);
        this.insertionOrder.push(agent.name);
    }

    lookup(name: string): AgentDefinition | undefined {
        return this.agents.get(name);
    }

    list(): readonly AgentDefinition[] {
        const ordered: AgentDefinition[] = [];
        for (const name of this.insertionOrder) {
            const agent = this.agents.get(name);
            if (agent !== undefined) {
                ordered.push(agent);
            }
        }
        return ordered;
    }

    names(): readonly string[] {
        return [...this.insertionOrder];
    }

    get diagnostics(): readonly AgentDiscoveryDiagnostic[] {
        return [...this.diagnosticsBuffer];
    }
}
