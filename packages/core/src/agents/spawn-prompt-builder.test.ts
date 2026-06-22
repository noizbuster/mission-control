import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildChildSystemPrompt, SUBAGENT_BASE_DIRECTIVE } from './spawn-prompt-builder.js';

const baseAgent: AgentDefinition = {
    name: 'worker',
    description: 'A generic worker agent.',
    systemPrompt: 'You complete tasks reliably.',
    source: 'bundled',
};

describe('buildChildSystemPrompt', () => {
    describe('four-layer composition order', () => {
        it('assembles all four layers in order: base, role preamble, agent body, parent context', () => {
            const agent: AgentDefinition = {
                name: 'researcher',
                description: 'A research agent.',
                systemPrompt: 'You investigate deeply and cite sources.',
                source: 'bundled',
            };
            const result = buildChildSystemPrompt({
                agent,
                role: 'Data Analyst',
                parentContext: 'The project uses TypeScript and Zod.',
            });

            const sections = result.split('\n\n');
            expect(sections).toHaveLength(4);
            expect(sections[0]).toBe(SUBAGENT_BASE_DIRECTIVE);
            expect(sections[1]).toBe('Specializing as: **Data Analyst**');
            expect(sections[2]).toBe('You investigate deeply and cite sources.');
            expect(sections[3]).toBe('Shared context:\nThe project uses TypeScript and Zod.');
        });
    });

    describe('role preamble layer', () => {
        it('skips the preamble when role is undefined', () => {
            const result = buildChildSystemPrompt({ agent: baseAgent });
            expect(result).not.toContain('Specializing as:');
            const sections = result.split('\n\n');
            expect(sections).toHaveLength(2);
            expect(sections[0]).toBe(SUBAGENT_BASE_DIRECTIVE);
        });

        it('skips the preamble when role is an empty string', () => {
            const result = buildChildSystemPrompt({ agent: baseAgent, role: '' });
            expect(result).not.toContain('Specializing as:');
        });

        it('skips the preamble when role is whitespace-only', () => {
            const result = buildChildSystemPrompt({ agent: baseAgent, role: '   \n\t ' });
            expect(result).not.toContain('Specializing as:');
        });

        it('trims leading and trailing whitespace from the role', () => {
            const result = buildChildSystemPrompt({ agent: baseAgent, role: '  Data Analyst  ' });
            expect(result).toContain('Specializing as: **Data Analyst**');
        });

        it('collapses internal whitespace so a multi-line role stays one preamble line', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Auth\n  flow   reviewer',
            });
            expect(result).toContain('Specializing as: **Auth flow reviewer**');
        });

        it('strips ASCII control characters (0x00-0x1F, 0x7F) from the role', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Data\x00\x07Analyst\x7f',
            });
            const preamble = result.split('\n\n')[1];
            expect(preamble).toBe('Specializing as: **Data Analyst**');
            expect(preamble ?? '').not.toMatch(/[\p{Cc}\p{Cf}]/u);
        });

        it('replaces Unicode control and zero-width format chars with spaces, not removing adjacent words', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Auth\u0085flow\u200breviewer',
            });
            const preamble = result.split('\n\n')[1];
            expect(preamble).toBe('Specializing as: **Auth flow reviewer**');
            expect(preamble ?? '').not.toMatch(/[\p{Cc}\p{Cf}]/u);
        });
    });

    describe('parent context layer', () => {
        it('skips the context layer when parentContext is undefined', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Runner',
            });
            expect(result).not.toContain('Shared context:');
        });

        it('skips the context layer when parentContext is an empty string', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Runner',
                parentContext: '',
            });
            expect(result).not.toContain('Shared context:');
        });

        it('includes the context under a "Shared context:" header when provided', () => {
            const result = buildChildSystemPrompt({
                agent: baseAgent,
                role: 'Runner',
                parentContext: 'Batch run #42 context.',
            });
            expect(result).toContain('Shared context:\nBatch run #42 context.');
        });
    });

    describe('agent system prompt body layer', () => {
        it('omits the body section when agent.systemPrompt is empty', () => {
            const agent: AgentDefinition = {
                name: 'empty-worker',
                description: 'A worker with no prompt body.',
                systemPrompt: '',
                source: 'bundled',
            };
            const result = buildChildSystemPrompt({ agent, role: 'Runner' });

            const sections = result.split('\n\n');
            expect(sections).toHaveLength(2);
            expect(sections[0]).toBe(SUBAGENT_BASE_DIRECTIVE);
            expect(sections[1]).toBe('Specializing as: **Runner**');
        });

        it('emits base directive only when role, body, and context are all absent', () => {
            const agent: AgentDefinition = {
                name: 'bare',
                description: 'Bare agent.',
                systemPrompt: '',
                source: 'bundled',
            };
            const result = buildChildSystemPrompt({ agent });
            expect(result).toBe(SUBAGENT_BASE_DIRECTIVE);
        });
    });
});
