import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt, DEFAULT_CODING_AGENT_PERSONA } from './system-prompt.js';

describe('assembleSystemPrompt', () => {
    it('returns a non-empty persona with coding-agent identity and tool-usage guidance', () => {
        const prompt = assembleSystemPrompt();
        expect(prompt.length).toBeGreaterThan(0);
        expect(prompt).toContain('coding agent');
        // P0 gap closed: tool-usage guidance is present.
        expect(prompt.toLowerCase()).toContain('tool call');
        expect(prompt).toContain('approval');
    });

    it('includes the environment block when env is provided', () => {
        const prompt = assembleSystemPrompt({
            env: { modelId: 'claude-fable-5', cwd: '/repo', gitEnabled: true, date: '2026-06-16' },
        });
        expect(prompt).toContain('Model: claude-fable-5');
        expect(prompt).toContain('Working directory: /repo');
        expect(prompt).toContain('Git: yes');
        expect(prompt).toContain('Date: 2026-06-16');
    });

    it('renders available tools and guidelines', () => {
        const prompt = assembleSystemPrompt({
            toolSnippets: [{ name: 'repo.read', description: 'read a file' }],
            guidelines: ['prefer edit over write'],
        });
        expect(prompt).toContain('# Available tools');
        expect(prompt).toContain('repo.read: read a file');
        expect(prompt).toContain('# Guidelines');
        expect(prompt).toContain('prefer edit over write');
    });

    it('renders project instructions via the shared formatProjectContext formatter', () => {
        const prompt = assembleSystemPrompt({
            resources: [
                { path: 'AGENTS.md', content: 'Always use pnpm.' },
                { path: 'CLAUDE.md', content: 'No unsafe casts.' },
            ],
            append: 'Follow the commit protocol.',
        });
        expect(prompt).toContain('# Project instructions');
        expect(prompt).toContain('--- AGENTS.md ---');
        expect(prompt).toContain('Always use pnpm.');
        expect(prompt).toContain('--- CLAUDE.md ---');
        expect(prompt).toContain('No unsafe casts.');
        expect(prompt.endsWith('Follow the commit protocol.')).toBe(true);
    });

    it('uses a custom persona when provided', () => {
        const prompt = assembleSystemPrompt({ persona: 'You are a specialized reviewer.' });
        expect(prompt.startsWith('You are a specialized reviewer.')).toBe(true);
        expect(prompt).not.toContain(DEFAULT_CODING_AGENT_PERSONA.slice(0, 40));
    });

    it('omits the guidelines section when no guidelines are provided', () => {
        const prompt = assembleSystemPrompt({});
        expect(prompt).not.toContain('# Guidelines');
    });

    it('omits the guidelines section for empty or whitespace-only guideline strings', () => {
        expect(assembleSystemPrompt({ guidelines: [''] })).not.toContain('# Guidelines');
        expect(assembleSystemPrompt({ guidelines: ['   '] })).not.toContain('# Guidelines');
        expect(assembleSystemPrompt({ guidelines: ['', '   ', 'valid hint'] })).toContain('# Guidelines');
        expect(assembleSystemPrompt({ guidelines: ['', '   ', 'valid hint'] })).toContain('valid hint');
    });

    it('renders skills as the canonical <available_skills> XML block with name, description, and location', () => {
        const prompt = assembleSystemPrompt({
            skills: [
                {
                    name: 'git-master',
                    description: 'Git operations skill.',
                    location: '/home/user/.config/mission-control/skills/git-master/SKILL.md',
                },
                {
                    name: 'review-work',
                    description: 'Post-implementation review.',
                },
            ],
        });
        expect(prompt).not.toContain('# Skills');
        expect(prompt).toContain('<available_skills>');
        expect(prompt).toContain('</available_skills>');
        expect(prompt).toContain('The following skills provide specialized instructions for specific tasks.');
        expect(prompt).toContain('Use the skill tool to load a skill when the task matches its description.');
        expect(prompt).toContain('<name>git-master</name>');
        expect(prompt).toContain('<description>Git operations skill.</description>');
        expect(prompt).toContain('<location>/home/user/.config/mission-control/skills/git-master/SKILL.md</location>');
        expect(prompt).toContain('<name>review-work</name>');
        expect(prompt).toContain('<description>Post-implementation review.</description>');
    });

    it('omits the <available_skills> block when no skills are provided', () => {
        expect(assembleSystemPrompt({})).not.toContain('<available_skills>');
        expect(assembleSystemPrompt({ skills: [] })).not.toContain('<available_skills>');
    });

    it('XML-escapes special characters in skill names and descriptions', () => {
        const prompt = assembleSystemPrompt({
            skills: [
                {
                    name: 'xss-test',
                    description: 'Reads <script> & "payload" data.',
                },
            ],
        });
        expect(prompt).toContain('<description>Reads &lt;script&gt; &amp; "payload" data.</description>');
        expect(prompt).not.toContain('<script>');
    });

    it('renders workflows as the canonical <available_workflows> XML block', () => {
        const prompt = assembleSystemPrompt({
            workflows: [
                { name: 'ralph-loop', description: 'Self-referential loop until completion.', categories: ['coding'] },
                { name: 'review-work', description: 'Post-implementation review.' },
            ],
        });
        expect(prompt).toContain('<available_workflows>');
        expect(prompt).toContain('</available_workflows>');
        expect(prompt).toContain('<name>ralph-loop</name>');
        expect(prompt).toContain('<description>Self-referential loop until completion.</description>');
        expect(prompt).toContain('<categories>coding</categories>');
        expect(prompt).toContain('<name>review-work</name>');
        expect(prompt).toContain('<description>Post-implementation review.</description>');
        expect(prompt).not.toContain('<name>review-work</name><categories>');
    });

    it('renders workflows with multiple categories as a comma-separated list', () => {
        const prompt = assembleSystemPrompt({
            workflows: [
                { name: 'default', description: 'Fallback workflow.', categories: ['deep', 'quick', 'plan'] },
            ],
        });
        expect(prompt).toContain('<categories>deep, quick, plan</categories>');
    });

    it('omits the <description> and <categories> tags when not present on a workflow', () => {
        const prompt = assembleSystemPrompt({
            workflows: [{ name: 'bare' }],
        });
        expect(prompt).toContain('<name>bare</name>');
        expect(prompt).not.toContain('<description>');
        expect(prompt).not.toContain('<categories>');
    });

    it('omits the <available_workflows> block when no workflows are provided', () => {
        expect(assembleSystemPrompt({})).not.toContain('<available_workflows>');
        expect(assembleSystemPrompt({ workflows: [] })).not.toContain('<available_workflows>');
    });

    it('XML-escapes special characters in workflow names, descriptions, and categories', () => {
        const prompt = assembleSystemPrompt({
            workflows: [
                {
                    name: 'a&b<c>',
                    description: 'Runs <script> & "payload" data.',
                    categories: ['cat<1>', 'cat&2'],
                },
            ],
        });
        expect(prompt).toContain('<name>a&amp;b&lt;c&gt;</name>');
        expect(prompt).toContain('<description>Runs &lt;script&gt; &amp; "payload" data.</description>');
        expect(prompt).toContain('<categories>cat&lt;1&gt;, cat&amp;2</categories>');
        expect(prompt).not.toContain('<script>');
    });

    it('includes the context baseline before project instructions', () => {
        const prompt = assembleSystemPrompt({
            contextBaseline: 'Boulder state: iteration 3 of 10.',
            resources: [{ path: 'AGENTS.md', content: 'Always use pnpm.' }],
        });
        const baselineIndex = prompt.indexOf('Boulder state: iteration 3 of 10.');
        const instructionsIndex = prompt.indexOf('# Project instructions');
        expect(baselineIndex).toBeGreaterThan(-1);
        expect(instructionsIndex).toBeGreaterThan(-1);
        expect(baselineIndex).toBeLessThan(instructionsIndex);
    });

    it('omits empty context baseline', () => {
        expect(assembleSystemPrompt({ contextBaseline: '   ' })).not.toContain('contextBaseline');
    });
});
