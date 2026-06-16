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
});
