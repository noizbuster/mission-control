import type { SubAgent } from './sub-agent.js';

/**
 * @deprecated Use AgentIndex from './agent-registry.js' instead. This class is scaffold and will be removed in v3.
 */
export class SubAgentRegistry {
    private readonly agents = new Map<string, SubAgent>();

    register(agent: SubAgent): void {
        if (this.agents.has(agent.id)) {
            throw new Error(`sub-agent already registered: ${agent.id}`);
        }
        this.agents.set(agent.id, agent);
    }

    resolve(id: string): SubAgent {
        const agent = this.agents.get(id);
        if (agent === undefined) {
            throw new Error(`sub-agent not found: ${id}`);
        }
        return agent;
    }

    list(): readonly SubAgent[] {
        return [...this.agents.values()];
    }
}
