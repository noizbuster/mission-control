import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentParseError, parseAgentFile } from './agent-parser.js';

const FILE = '/agents/test.md';
const SOURCE = 'project' as const;

function agent(frontmatter: string | readonly string[], body: string): string {
    const fm = Array.isArray(frontmatter) ? frontmatter.join('\n') : frontmatter;
    return `---\n${fm}\n---\n${body}`;
}

describe('parseAgentFile — valid input', () => {
    it('(a) parses frontmatter with tools as a CSV string into a string array', () => {
        const content = agent(
            ['name: researcher', 'description: A read-only research agent.', 'tools: read, search, find'].join('\n'),
            'You are a research agent.',
        );
        const result = parseAgentFile(FILE, content, SOURCE);
        expect(result.name).toBe('researcher');
        expect(result.description).toBe('A read-only research agent.');
        expect(result.systemPrompt).toBe('You are a research agent.');
        expect(result.source).toBe('project');
        expect(result.filePath).toBe(FILE);
        expect(result.tools).toEqual(['read', 'search', 'find']);
    });

    it('trims whitespace and drops empty CSV segments', () => {
        const content = agent(['name: a', 'description: d.', 'tools: read,  search ,, find,'].join('\n'), 'body');
        expect(parseAgentFile(FILE, content, SOURCE).tools).toEqual(['read', 'search', 'find']);
    });

    it('(b) passes tools through when given as a YAML array', () => {
        const content = agent(
            ['name: coder', 'description: A coding agent.', 'tools:', '  - read', '  - edit', '  - bash'].join('\n'),
            'You write code.',
        );
        expect(parseAgentFile(FILE, content, SOURCE).tools).toEqual(['read', 'edit', 'bash']);
    });

    it('(c) extracts only true-valued keys when tools is an object map', () => {
        const content = agent(
            [
                'name: triager',
                'description: A triage agent.',
                'tools:',
                '  "/": false',
                '  github-triage: true',
                '  search: true',
                '  disabled-tool: false',
            ].join('\n'),
            'You triage issues.',
        );
        const tools = parseAgentFile(FILE, content, SOURCE).tools;
        expect(tools).toBeDefined();
        expect([...(tools ?? [])].sort()).toEqual(['github-triage', 'search']);
    });

    it('returns AgentDefinition typed object', () => {
        const content = agent(['name: x', 'description: y.', 'tools: read'].join('\n'), 'body');
        const result: AgentDefinition = parseAgentFile(FILE, content, SOURCE);
        expect(result.name).toBe('x');
    });
});

describe('parseAgentFile — model field', () => {
    it('(h) passes a string model alias through unchanged', () => {
        const content = agent(['name: fast', 'description: Fast agent.', 'model: mctrl/smol'].join('\n'), 'body');
        expect(parseAgentFile(FILE, content, SOURCE).model).toBe('mctrl/smol');
    });

    it('(i) passes a providerID/modelID object through unchanged', () => {
        const content = agent(
            [
                'name: pro',
                'description: Pro agent.',
                'model:',
                '  providerID: anthropic',
                '  modelID: claude-sonnet-4',
            ].join('\n'),
            'body',
        );
        expect(parseAgentFile(FILE, content, SOURCE).model).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4',
        });
    });
});

describe('parseAgentFile — pathPolicies', () => {
    it('(j) parses and validates pathPolicies entries', () => {
        const content = agent(
            [
                'name: gated',
                'description: Gated agent.',
                'pathPolicies:',
                '  - action: edit',
                '    resource: src/**',
                '    effect: allow',
                '  - action: write',
                "    resource: '**'",
                '    effect: deny',
            ].join('\n'),
            'body',
        );
        const result = parseAgentFile(FILE, content, SOURCE);
        expect(result.pathPolicies).toEqual([
            { action: 'edit', resource: 'src/**', effect: 'allow' },
            { action: 'write', resource: '**', effect: 'deny' },
        ]);
    });
});

describe('parseAgentFile — error cases', () => {
    it('(d) throws AgentParseError when frontmatter opening fence is missing', () => {
        expect(() => parseAgentFile(FILE, 'just a body, no fences', SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when the opening fence is missing but a closing one exists', () => {
        expect(() => parseAgentFile(FILE, 'name: x\n---\nbody', SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when the closing fence is missing', () => {
        const content = `---\nname: x\ndescription: y.\nbody without closing fence`;
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('(e) throws AgentParseError when the body is empty', () => {
        const content = agent(['name: nob', 'description: No body.'].join('\n'), '');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when the body is only whitespace', () => {
        const content = agent(['name: nob', 'description: No body.'].join('\n'), '   \n\t\n  ');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('(f) throws AgentParseError on invalid YAML', () => {
        const content = agent(['name: broken', '  description: bad indent', 'foo: [unclosed'].join('\n'), 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when frontmatter YAML is a scalar', () => {
        const content = agent('just-a-string', 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when frontmatter YAML is a sequence', () => {
        const content = agent(['- item1', '- item2'].join('\n'), 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when frontmatter has no fields (empty)', () => {
        const content = agent('', 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('(g) throws AgentParseError when required name field is missing', () => {
        const content = agent(['description: No name.'], 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when required description field is missing', () => {
        const content = agent(['name: nodesc'], 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });

    it('throws AgentParseError when an unknown frontmatter key is present (strict schema)', () => {
        const content = agent(['name: x', 'description: y.', 'bogusField: nope'], 'body');
        expect(() => parseAgentFile(FILE, content, SOURCE)).toThrow(AgentParseError);
    });
});

describe('AgentParseError', () => {
    it('exposes code, filePath, and cause fields', () => {
        let caught: AgentParseError | undefined;
        try {
            parseAgentFile('/path/to/agent.md', 'no fences here', SOURCE);
        } catch (error) {
            if (error instanceof AgentParseError) {
                caught = error;
            }
        }
        expect(caught).toBeDefined();
        expect(caught?.code).toBe('parse_failed');
        expect(caught?.filePath).toBe('/path/to/agent.md');
        expect(caught?.name).toBe('AgentParseError');
        expect(caught instanceof Error).toBe(true);
    });

    it('populates cause with the Zod error when schema validation fails', () => {
        let caught: AgentParseError | undefined;
        try {
            parseAgentFile(FILE, agent(['description: no name'], 'body'), SOURCE);
        } catch (error) {
            if (error instanceof AgentParseError) {
                caught = error;
            }
        }
        expect(caught).toBeDefined();
        expect(caught?.cause).toBeDefined();
    });

    it('message describes the failure reason', () => {
        let message = '';
        try {
            parseAgentFile(FILE, 'no fences', SOURCE);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message.toLowerCase()).toContain('fence');
    });
});
