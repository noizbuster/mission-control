import { describe, expect, it } from 'vitest';
import type { AgentExecutionContext } from '../runtime/execution-context.js';
import { SubAgentRegistry } from './registry.js';
import type { SubAgent } from './sub-agent.js';

describe('SubAgentRegistry', () => {
    it('registers and resolves mock SubAgent', async () => {
        const registry = new SubAgentRegistry();
        const agent: SubAgent = {
            id: 'agent_mock',
            name: 'Mock Agent',
            async run(input, _context: AgentExecutionContext) {
                return {
                    output: `handled ${input.prompt}`,
                };
            },
        };

        registry.register(agent);

        expect(registry.list()).toHaveLength(1);
        await expect(
            registry.resolve('agent_mock').run({ prompt: 'demo' }, { sessionId: 'session_test' }),
        ).resolves.toEqual({
            output: 'handled demo',
        });
    });
});
