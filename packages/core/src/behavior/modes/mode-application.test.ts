import { type AbgGraphSpec, AbgGraphSpecSchema, type AbgNodeSpec, type Mode } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { autopilotMode } from './autopilot-mode.js';
import { applyMode } from './mode-application.js';

/** Read a string config value from a node, narrowing `unknown` from the Record. */
function configString(node: AbgNodeSpec | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

/** Minimal valid graph with the node shapes needed to exercise applyMode. */
function makeTestGraph(): AbgGraphSpec {
    const nodes: AbgNodeSpec[] = [
        {
            id: 'llm-with-prompt',
            kind: 'llm',
            label: 'LLM node with existing system prompt',
            config: { systemPrompt: 'ORIGINAL_PROMPT', outputKey: 'result' },
        },
        {
            id: 'llm-no-prompt',
            kind: 'llm',
            label: 'LLM node without system prompt',
        },
        {
            id: 'memory-node',
            kind: 'memory',
            label: 'Memory node — must NOT receive overlay',
            config: { outputKey: 'memory.loaded' },
        },
        {
            id: 'llm-with-capabilities',
            kind: 'llm',
            label: 'LLM node with capabilities for tool filtering',
            capabilities: ['read', 'edit', 'task'],
            config: { systemPrompt: 'WORKER_PROMPT' },
        },
    ];
    return {
        id: 'test-graph',
        entryNodeId: 'llm-with-prompt',
        nodes,
        edges: [],
        rules: [],
        policies: [{ id: 'existing-policy', capability: 'read', decision: 'allow' }],
    };
}

describe('applyMode — system prompt overlay', () => {
    it('prepends the overlay before the existing prompt on llm-actor nodes', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'test',
            systemPromptOverlay: 'OVERLAY_TEXT',
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-prompt');
        const prompt = configString(node, 'systemPrompt');

        expect(typeof prompt).toBe('string');
        expect(prompt).toContain('OVERLAY_TEXT');
        expect(prompt).toContain('ORIGINAL_PROMPT');
        const overlayIdx = prompt !== undefined ? prompt.indexOf('OVERLAY_TEXT') : -1;
        const originalIdx = prompt !== undefined ? prompt.indexOf('ORIGINAL_PROMPT') : -1;
        expect(overlayIdx).toBeLessThan(originalIdx);
    });

    it('sets the overlay as the full prompt when the llm node has no existing prompt', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'test',
            systemPromptOverlay: 'SOLO_OVERLAY',
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-no-prompt');

        expect(configString(node, 'systemPrompt')).toBe('SOLO_OVERLAY');
    });

    it('does NOT modify non-llm nodes', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'test',
            systemPromptOverlay: 'OVERLAY',
            policies: [],
        };

        const result = applyMode(graph, mode);
        const memoryNode = result.nodes.find((n) => n.id === 'memory-node');

        expect(configString(memoryNode, 'systemPrompt')).toBeUndefined();
    });

    it('preserves other config keys on overlaid nodes', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'test',
            systemPromptOverlay: 'OVERLAY',
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-prompt');

        expect(configString(node, 'outputKey')).toBe('result');
    });

    it('skips overlay when systemPromptOverlay is absent', () => {
        const graph = makeTestGraph();
        const mode: Mode = { id: 'no-overlay', policies: [] };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-prompt');

        expect(configString(node, 'systemPrompt')).toBe('ORIGINAL_PROMPT');
    });
});

describe('applyMode — policies', () => {
    it('appends converted mode policies to graph.policies', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'guarded',
            policies: [
                { action: 'edit', resource: '**', effect: 'ask' },
                { action: 'bash', resource: '**', effect: 'deny' },
            ],
        };

        const result = applyMode(graph, mode);

        expect(result.policies).toHaveLength(3);
        // Original policy preserved.
        expect(result.policies[0]).toEqual({ id: 'existing-policy', capability: 'read', decision: 'allow' });
        // Mode policies converted and appended.
        expect(result.policies[1]).toEqual({
            id: 'guarded:policy:0',
            capability: 'edit',
            decision: 'requires_approval',
            reason: 'resource:**',
        });
        expect(result.policies[2]).toEqual({
            id: 'guarded:policy:1',
            capability: 'bash',
            decision: 'deny',
            reason: 'resource:**',
        });
    });

    it('maps all three PolicyEffect values correctly', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'effects',
            policies: [
                { action: 'read', resource: 'src/*', effect: 'allow' },
                { action: 'write', resource: 'secrets/*', effect: 'deny' },
                { action: 'edit', resource: '**', effect: 'ask' },
            ],
        };

        const result = applyMode(graph, mode);
        const decisions = result.policies.slice(1).map((p) => p.decision);

        expect(decisions).toEqual(['allow', 'deny', 'requires_approval']);
    });

    it('preserves the resource glob in the reason field', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'scoped',
            policies: [{ action: 'edit', resource: 'src/**/*.ts', effect: 'ask' }],
        };

        const result = applyMode(graph, mode);
        const added = result.policies[1];

        expect(added?.reason).toBe('resource:src/**/*.ts');
    });

    it('handles empty policies array without changing graph.policies content', () => {
        const graph = makeTestGraph();
        const mode: Mode = { id: 'empty', policies: [] };

        const result = applyMode(graph, mode);

        expect(result.policies).toEqual(graph.policies);
    });
});

describe('applyMode — requiredTools filter', () => {
    it('intersects node capabilities with requiredTools', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'restricted',
            requiredTools: ['read', 'bash'],
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-capabilities');

        expect(node?.capabilities).toEqual(['read']);
    });

    it('leaves nodes without capabilities unchanged', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'restricted',
            requiredTools: ['read'],
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-prompt');

        expect(node?.capabilities).toBeUndefined();
    });

    it('skips filtering when requiredTools is empty', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'no-filter',
            requiredTools: [],
            policies: [],
        };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-capabilities');

        expect(node?.capabilities).toEqual(['read', 'edit', 'task']);
    });

    it('skips filtering when requiredTools is absent', () => {
        const graph = makeTestGraph();
        const mode: Mode = { id: 'no-filter', policies: [] };

        const result = applyMode(graph, mode);
        const node = result.nodes.find((n) => n.id === 'llm-with-capabilities');

        expect(node?.capabilities).toEqual(['read', 'edit', 'task']);
    });
});

describe('applyMode — immutability', () => {
    it('does not mutate the input graph', () => {
        const graph = makeTestGraph();
        const graphSnapshot = JSON.parse(JSON.stringify(graph)) as AbgGraphSpec;
        const mode: Mode = {
            id: 'mutate-test',
            systemPromptOverlay: 'OVERLAY',
            policies: [{ action: 'edit', resource: '**', effect: 'ask' }],
            requiredTools: ['read'],
        };

        applyMode(graph, mode);

        expect(graph).toEqual(graphSnapshot);
    });

    it('returns a different object reference than the input', () => {
        const graph = makeTestGraph();
        const mode: Mode = { id: 'ref-test', policies: [] };

        const result = applyMode(graph, mode);

        expect(result).not.toBe(graph);
    });

    it('returns new node object references for modified nodes', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'ref-test',
            systemPromptOverlay: 'OVERLAY',
            policies: [],
        };

        const result = applyMode(graph, mode);
        const originalNode = graph.nodes.find((n) => n.id === 'llm-with-prompt');
        const resultNode = result.nodes.find((n) => n.id === 'llm-with-prompt');

        expect(resultNode).not.toBe(originalNode);
    });

    it('returns new arrays for nodes and policies', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'array-test',
            systemPromptOverlay: 'OVERLAY',
            policies: [{ action: 'edit', resource: '**', effect: 'ask' }],
        };

        const result = applyMode(graph, mode);

        expect(result.nodes).not.toBe(graph.nodes);
        expect(result.policies).not.toBe(graph.policies);
    });
});

describe('applyMode — schema validity', () => {
    it('produces a graph that validates against AbgGraphSpecSchema', () => {
        const graph = makeTestGraph();
        const mode: Mode = {
            id: 'schema-test',
            systemPromptOverlay: 'OVERLAY_TEXT',
            policies: [
                { action: 'edit', resource: '**', effect: 'ask' },
                { action: 'bash', resource: '**', effect: 'deny' },
            ],
            requiredTools: ['read'],
        };

        const result = applyMode(graph, mode);
        const parseResult = AbgGraphSpecSchema.safeParse(result);

        expect(parseResult.success).toBe(true);
    });
});

describe('autopilotMode declaration', () => {
    it('has id "autopilot"', () => {
        expect(autopilotMode.id).toBe('autopilot');
    });

    it('has a concise systemPromptOverlay (under 4000 chars)', () => {
        expect(autopilotMode.systemPromptOverlay).toBeDefined();
        const length = autopilotMode.systemPromptOverlay?.length ?? 0;
        // Condensed to principle directives — should be far shorter than the 331-line source.
        expect(length).toBeLessThan(4000);
        expect(length).toBeGreaterThan(500);
    });

    it('covers all six required directives in the overlay', () => {
        const overlay = autopilotMode.systemPromptOverlay ?? '';

        expect(overlay.toLowerCase()).toContain('certainty');
        expect(overlay.toLowerCase()).toContain('scenario');
        expect(overlay.toLowerCase()).toContain('test-driven');
        expect(overlay.toLowerCase()).toContain('qa');
        expect(overlay.toLowerCase()).toContain('reviewer');
        expect(overlay.toLowerCase()).toContain('self-approval');
    });

    it('requires approval before edit via policy-gate', () => {
        const editPolicy = autopilotMode.policies.find((p) => p.action === 'edit' && p.resource === '**');

        expect(editPolicy).toBeDefined();
        expect(editPolicy?.effect).toBe('ask');
    });

    it('has empty requiredTools (unrestricted tool surface)', () => {
        expect(autopilotMode.requiredTools).toEqual([]);
    });

    it('when applied to a graph, prepends the overlay to llm-actor prompts and blocks edit-without-scenario', () => {
        const graph = makeTestGraph();
        const result = applyMode(graph, autopilotMode);
        const llmNode = result.nodes.find((n) => n.id === 'llm-with-prompt');
        const prompt = configString(llmNode, 'systemPrompt');

        expect(prompt).toContain('autopilot mode');
        expect(prompt).toContain('ORIGINAL_PROMPT');
        const overlayIdx = prompt !== undefined ? prompt.indexOf('autopilot mode') : -1;
        const originalIdx = prompt !== undefined ? prompt.indexOf('ORIGINAL_PROMPT') : -1;
        expect(overlayIdx).toBeLessThan(originalIdx);

        // Edit policy added with requires_approval decision.
        const editPolicy = result.policies.find((p) => p.capability === 'edit');
        expect(editPolicy?.decision).toBe('requires_approval');
    });
});
