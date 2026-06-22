import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    formatAgentDetails,
    formatAgentsList,
    parseAgentsCommand,
    parseAgentsSlashLine,
} from './agents-command.js';

describe('parseAgentsCommand', () => {
    describe('required TDD cases', () => {
        it('parses empty input as list command', () => {
            // Given: empty tail after /agents
            // When: parsing the command
            // Then: result is a list command
            expect(parseAgentsCommand('')).toEqual({ kind: 'list' });
        });

        it('parses reload keyword as reload command', () => {
            // Given: tail "reload"
            // When: parsing the command
            // Then: result is a reload command
            expect(parseAgentsCommand('reload')).toEqual({ kind: 'reload' });
        });

        it('parses a single name token as show command', () => {
            // Given: tail "explore"
            // When: parsing the command
            // Then: result is a show command with the agent name
            expect(parseAgentsCommand('explore')).toEqual({ kind: 'show', name: 'explore' });
        });

        it('parses disable <name> as disable command', () => {
            // Given: tail "disable oracle"
            // When: parsing the command
            // Then: result is a disable command targeting the named agent
            expect(parseAgentsCommand('disable oracle')).toEqual({ kind: 'disable', name: 'oracle' });
        });

        it('parses whitespace-only input as list command', () => {
            // Given: whitespace-only tail
            // When: parsing the command
            // Then: result collapses to list (same as empty input)
            expect(parseAgentsCommand('   ')).toEqual({ kind: 'list' });
        });
    });

    describe('disable subcommand edge cases', () => {
        it('rejects disable without an agent name', () => {
            expect(parseAgentsCommand('disable')).toEqual({
                kind: 'invalid',
                message: '/agents disable requires an agent name',
            });
        });

        it('rejects disable with multiple trailing tokens', () => {
            expect(parseAgentsCommand('disable oracle extra')).toEqual({
                kind: 'invalid',
                message: '/agents disable accepts exactly one agent name',
            });
        });
    });

    describe('reload subcommand edge cases', () => {
        it('rejects reload with trailing arguments', () => {
            expect(parseAgentsCommand('reload force')).toEqual({
                kind: 'invalid',
                message: '/agents reload does not accept arguments',
            });
        });
    });

    describe('show subcommand edge cases', () => {
        it('rejects show with multiple tokens', () => {
            expect(parseAgentsCommand('foo bar')).toEqual({
                kind: 'invalid',
                message: '/agents accepts at most one agent name',
            });
        });

        it('treats leading and trailing whitespace around a name as equivalent', () => {
            expect(parseAgentsCommand('  explore  ')).toEqual({ kind: 'show', name: 'explore' });
        });
    });
});

describe('parseAgentsSlashLine', () => {
    it('parses /agents as list command', () => {
        expect(parseAgentsSlashLine('/agents')).toEqual({ kind: 'list' });
    });

    it('parses /agents reload as reload command', () => {
        expect(parseAgentsSlashLine('/agents reload')).toEqual({ kind: 'reload' });
    });

    it('parses /agents explore as show command', () => {
        expect(parseAgentsSlashLine('/agents explore')).toEqual({ kind: 'show', name: 'explore' });
    });

    it('parses /agents disable oracle as disable command', () => {
        expect(parseAgentsSlashLine('/agents disable oracle')).toEqual({
            kind: 'disable',
            name: 'oracle',
        });
    });

    it('returns undefined for non-agents slash commands', () => {
        expect(parseAgentsSlashLine('/model')).toBeUndefined();
        expect(parseAgentsSlashLine('/sessions')).toBeUndefined();
        expect(parseAgentsSlashLine('hello world')).toBeUndefined();
        expect(parseAgentsSlashLine('')).toBeUndefined();
    });

    it('does not match /agentslist or similar prefixed lines', () => {
        expect(parseAgentsSlashLine('/agentslist')).toBeUndefined();
        expect(parseAgentsSlashLine('/agentsx reload')).toBeUndefined();
    });

    it('trims surrounding whitespace from the slash line', () => {
        expect(parseAgentsSlashLine('  /agents reload  ')).toEqual({ kind: 'reload' });
    });
});

describe('formatAgentsList', () => {
    it('reports no agents when the list is empty', () => {
        expect(formatAgentsList([])).toBe('No agents discovered.\n');
    });

    it('formats each agent with name, source, model, and tier', () => {
        // Given: a mix of agents with and without optional model/tier
        const agents: AgentDefinition[] = [
            {
                name: 'explore',
                description: 'Explores the codebase.',
                systemPrompt: '...',
                source: 'project',
                model: 'openai/gpt-4',
                tier: 'read',
            },
            {
                name: 'oracle',
                description: 'High-reasoning consultant.',
                systemPrompt: '...',
                source: 'user',
                model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
                tier: 'write',
            },
            {
                name: 'worker',
                description: 'Generic worker.',
                systemPrompt: '...',
                source: 'bundled',
            },
        ];

        // When
        const output = formatAgentsList(agents);

        // Then
        expect(output).toContain('Discovered agents (3):');
        expect(output).toContain('- explore [project] model: openai/gpt-4 tier: read');
        expect(output).toContain('- oracle [user] model: anthropic/claude-sonnet-4 tier: write');
        expect(output).toContain('- worker [bundled]');
        expect(output.endsWith('\n')).toBe(true);
    });
});

describe('formatAgentDetails', () => {
    it('formats core fields plus optional model, tier, and tools', () => {
        const agent: AgentDefinition = {
            name: 'oracle',
            description: 'High-reasoning consultant.',
            systemPrompt: 'You reason carefully.',
            source: 'user',
            model: 'anthropic/claude-opus-4',
            tier: 'read',
            role: 'Reviewer',
            tools: ['repo.read', 'repo.search'],
        };

        const output = formatAgentDetails(agent);

        expect(output).toContain('Agent: oracle');
        expect(output).toContain('Description: High-reasoning consultant.');
        expect(output).toContain('Source: user');
        expect(output).toContain('Model: anthropic/claude-opus-4');
        expect(output).toContain('Tier: read');
        expect(output).toContain('Role: Reviewer');
        expect(output).toContain('Tools: repo.read, repo.search');
    });

    it('formats object-shaped model as providerID/modelID', () => {
        const agent: AgentDefinition = {
            name: 'runner',
            description: 'Runs plans.',
            systemPrompt: '...',
            source: 'project',
            model: { providerID: 'openai', modelID: 'o3' },
        };

        expect(formatAgentDetails(agent)).toContain('Model: openai/o3');
    });

    it('omits the model line when model is undefined', () => {
        const agent: AgentDefinition = {
            name: 'minimal',
            description: 'Minimal agent.',
            systemPrompt: '...',
            source: 'bundled',
        };

        expect(formatAgentDetails(agent)).not.toContain('Model:');
    });

    it('renders unlimited recursion for recursion === -1', () => {
        const agent: AgentDefinition = {
            name: 'deep',
            description: 'Deep agent.',
            systemPrompt: '...',
            source: 'plugin',
            recursion: -1,
        };

        expect(formatAgentDetails(agent)).toContain('Recursion: unlimited');
    });

    it('renders numeric recursion for finite values', () => {
        const agent: AgentDefinition = {
            name: 'shallow',
            description: 'Shallow agent.',
            systemPrompt: '...',
            source: 'plugin',
            recursion: 2,
        };

        expect(formatAgentDetails(agent)).toContain('Recursion: 2');
    });

    it('renders the disabled status flag', () => {
        const agent: AgentDefinition = {
            name: 'off',
            description: 'Disabled agent.',
            systemPrompt: '...',
            source: 'user',
            disabled: true,
        };

        expect(formatAgentDetails(agent)).toContain('Status: disabled');
    });

    it('renders wildcard spawns as *', () => {
        const agent: AgentDefinition = {
            name: 'spawner',
            description: 'Spawns anything.',
            systemPrompt: '...',
            source: 'project',
            spawns: '*',
        };

        expect(formatAgentDetails(agent)).toContain('Spawns: *');
    });

    it('renders named spawns as a comma-separated list', () => {
        const agent: AgentDefinition = {
            name: 'coordinator',
            description: 'Spawns specific agents.',
            systemPrompt: '...',
            source: 'project',
            spawns: ['explore', 'oracle'],
        };

        expect(formatAgentDetails(agent)).toContain('Spawns: explore, oracle');
    });
});
