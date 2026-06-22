import type { WorkflowSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { WorkflowRegistry } from '../../workflows/workflow-registry.js';
import type { ToolExecutionContext } from '../tool-registry-types.js';
import {
    createWorkflowToolRegistration,
    WORKFLOW_TOOL_NAME,
    type WorkflowToolOptions,
    workflowInputSchema,
} from './workflow-tool.js';

// --- Fixtures ---------------------------------------------------------------

function makeSpec(name: string, description?: string): WorkflowSpec {
    return {
        name,
        ...(description !== undefined ? { description } : {}),
        graph: {
            id: `graph-${name}`,
            entryNodeId: 'start',
            nodes: [{ id: 'start', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function makeRegistry(specs: readonly WorkflowSpec[] = []): WorkflowRegistry {
    return new WorkflowRegistry(specs);
}

function buildTool(options?: Partial<WorkflowToolOptions>): ReturnType<typeof createWorkflowToolRegistration> {
    return createWorkflowToolRegistration({
        registry: options?.registry ?? makeRegistry([makeSpec('planner'), makeSpec('runner')]),
    });
}

const CTX: ToolExecutionContext = {
    toolCallId: 'tc_test',
    toolName: WORKFLOW_TOOL_NAME,
    signal: new AbortController().signal,
};

// --- Tests ------------------------------------------------------------------

describe('workflow tool — registration metadata', () => {
    it('uses the canonical tool name', () => {
        const tool = buildTool();
        expect(tool.name).toBe(WORKFLOW_TOOL_NAME);
        expect(WORKFLOW_TOOL_NAME).toBe('workflow');
    });

    it('declares the workflow capability class', () => {
        const tool = buildTool();
        expect(tool.capabilityClasses).toEqual(['workflow']);
    });

    it('description lists known workflow names', () => {
        const tool = buildTool();
        expect(tool.description).toContain('planner');
        expect(tool.description).toContain('runner');
    });

    it('description shows (none discovered) for an empty registry', () => {
        const tool = buildTool({ registry: makeRegistry([]) });
        expect(tool.description).toContain('(none discovered)');
    });

    it('XML-escapes workflow names containing special characters in the description', () => {
        const registry = makeRegistry([makeSpec('a<b>&c')]);
        const tool = buildTool({ registry });
        expect(tool.description).toContain('a&lt;b&gt;&amp;c');
        expect(tool.description).not.toContain('a<b>&c');
    });

    it('provides a guideline that references <available_workflows>', () => {
        const tool = buildTool();
        expect(tool.guideline).toContain('<available_workflows>');
    });

    it('requires name and prompt in the JSON schema', () => {
        const tool = buildTool();
        const schema = tool.parametersJsonSchema as { readonly required: readonly string[] };
        expect(schema.required).toEqual(['name', 'prompt']);
    });
});

describe('workflow tool — schema validation', () => {
    it('parses valid name + prompt', () => {
        const parsed = workflowInputSchema.parse({ name: 'planner', prompt: 'plan the thing' });
        expect(parsed.name).toBe('planner');
        expect(parsed.prompt).toBe('plan the thing');
    });

    it('rejects an empty name', () => {
        const result = workflowInputSchema.safeParse({ name: '', prompt: 'go' });
        expect(result.success).toBe(false);
    });

    it('rejects an empty prompt', () => {
        const result = workflowInputSchema.safeParse({ name: 'planner', prompt: '' });
        expect(result.success).toBe(false);
    });

    it('rejects missing name', () => {
        const result = workflowInputSchema.safeParse({ prompt: 'go' });
        expect(result.success).toBe(false);
    });

    it('rejects missing prompt', () => {
        const result = workflowInputSchema.safeParse({ name: 'planner' });
        expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict mode)', () => {
        const result = workflowInputSchema.safeParse({ name: 'planner', prompt: 'go', extra: true });
        expect(result.success).toBe(false);
    });
});

describe('workflow tool — execute (started)', () => {
    it('returns started status for a known workflow', async () => {
        const tool = buildTool();
        const result = await tool.execute(workflowInputSchema.parse({ name: 'planner', prompt: 'plan X' }), CTX);
        expect(result.status).toBe('started');
        expect(result.workflowName).toBe('planner');
    });

    it('includes the workflow description in the started message when present', async () => {
        const registry = makeRegistry([makeSpec('planner', 'Plans tasks step by step')]);
        const tool = buildTool({ registry });
        const result = await tool.execute(workflowInputSchema.parse({ name: 'planner', prompt: 'plan X' }), CTX);
        expect(result.message).toContain('Plans tasks step by step');
    });

    it('includes a truncated prompt preview in the started message', async () => {
        const tool = buildTool();
        const longPrompt = 'A'.repeat(200);
        const result = await tool.execute(workflowInputSchema.parse({ name: 'planner', prompt: longPrompt }), CTX);
        expect(result.message).toContain('AAA');
        // Preview should be truncated, not the full 200 chars
        expect(result.message.length).toBeLessThan(longPrompt.length + 200);
    });

    it('toModelOutput returns the message field', () => {
        const tool = buildTool();
        const output = {
            status: 'started' as const,
            workflowName: 'planner',
            message: 'Workflow "planner" started.',
        };
        expect(tool.toModelOutput?.(output)).toBe('Workflow "planner" started.');
    });
});

describe('workflow tool — execute (not_found)', () => {
    it('returns not_found status for an unknown workflow', async () => {
        const tool = buildTool();
        const result = await tool.execute(workflowInputSchema.parse({ name: 'nonexistent', prompt: 'go' }), CTX);
        expect(result.status).toBe('not_found');
        expect(result.workflowName).toBe('nonexistent');
    });

    it('lists available workflow names in the not_found message', async () => {
        const tool = buildTool();
        const result = await tool.execute(workflowInputSchema.parse({ name: 'missing', prompt: 'go' }), CTX);
        expect(result.message).toContain('planner');
        expect(result.message).toContain('runner');
    });

    it('shows (none discovered) when the registry is empty', async () => {
        const tool = buildTool({ registry: makeRegistry([]) });
        const result = await tool.execute(workflowInputSchema.parse({ name: 'anything', prompt: 'go' }), CTX);
        expect(result.message).toContain('(none discovered)');
    });

    it('XML-escapes workflow names with special characters in the not_found message', async () => {
        const registry = makeRegistry([makeSpec('x<y>')]);
        const tool = buildTool({ registry });
        const result = await tool.execute(workflowInputSchema.parse({ name: 'missing', prompt: 'go' }), CTX);
        expect(result.message).toContain('x&lt;y&gt;');
        expect(result.message).not.toContain('x<y>');
    });

    it('does not throw on not_found (model-retryable return)', async () => {
        const tool = buildTool();
        const result = await tool.execute(workflowInputSchema.parse({ name: 'missing', prompt: 'go' }), CTX);
        expect(result).toBeDefined();
        expect(result.status).toBe('not_found');
    });
});

describe('workflow tool — registry mutation after registration', () => {
    it('picks up workflows registered after tool creation (registry is live)', async () => {
        const registry = makeRegistry([makeSpec('alpha')]);
        const tool = buildTool({ registry });
        // Register a new workflow after the tool was built
        registry.register(makeSpec('beta'));
        const result = await tool.execute(workflowInputSchema.parse({ name: 'beta', prompt: 'go' }), CTX);
        expect(result.status).toBe('started');
        expect(result.workflowName).toBe('beta');
    });
});
