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
});
