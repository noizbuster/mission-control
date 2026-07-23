import { describe, expect, it } from 'vitest';
import { parseAgentFile } from '../agent-parser';
import deep from './deep.md';
import architect from './architect.md';
import designer from './designer.md';
import explore from './explore.md';
import librarian from './librarian.md';
import executor from './executor.md';
import oracle from './oracle.md';
import planner from './planner.md';
import quick from './quick.md';
import reasoner from './reasoner.md';
import reviewer from './reviewer.md';
import writer from './writer.md';
import { BUNDLED_AGENT_TEMPLATES } from './index';

const BUNDLED_TEMPLATES = [
    { name: 'architect', template: architect },
    { name: 'quick', template: quick },
    { name: 'deep', template: deep },
    { name: 'reasoner', template: reasoner },
    { name: 'designer', template: designer },
    { name: 'executor', template: executor },
    { name: 'explore', template: explore },
    { name: 'oracle', template: oracle },
    { name: 'librarian', template: librarian },
    { name: 'planner', template: planner },
    { name: 'reviewer', template: reviewer },
    { name: 'writer', template: writer },
] as const;

describe('bundled agents — parse via parseAgentFile', () => {
    it('covers all 12 bundled agents', () => {
        expect(BUNDLED_TEMPLATES).toHaveLength(12);
    });

    it('registers every bundled declaration', () => {
        const registeredNames = BUNDLED_AGENT_TEMPLATES.map((template) =>
            parseAgentFile('/bundled/registered.md', template, 'bundled').name,
        ).sort();
        const declaredNames = BUNDLED_TEMPLATES.map(({ name }) => name).sort();

        expect(registeredNames).toEqual(declaredNames);
    });

    for (const { name, template } of BUNDLED_TEMPLATES) {
        it(`parses bundled/${name}.md into a valid AgentDefinition`, () => {
            const filePath = `/bundled/${name}.md`;
            const parsed = parseAgentFile(filePath, template, 'bundled');

            expect(parsed.name).toBe(name);
            expect(parsed.source).toBe('bundled');
            expect(parsed.filePath).toBe(filePath);
            expect(parsed.systemPrompt.length).toBeGreaterThan(0);
        });
    }

    it('planner carries the .mc/plans + .mc/notepads write allowlist and broad denies', () => {
        const parsed = parseAgentFile('/bundled/planner.md', planner, 'bundled');
        expect(parsed.pathPolicies).toEqual([
            { action: 'write', resource: '**', effect: 'deny' },
            { action: 'write', resource: '.mc/plans/**', effect: 'allow' },
            { action: 'write', resource: '.mc/notepads/**', effect: 'allow' },
            { action: 'edit', resource: '**', effect: 'deny' },
            { action: 'patch', resource: '**', effect: 'deny' },
            { action: 'bash', resource: '**', effect: 'deny' },
        ]);
    });

    it('read-only categories (explore, oracle, librarian, reviewer) omit write/edit tools', () => {
        const readOnly = ['explore', 'oracle', 'librarian', 'reviewer'];
        for (const name of readOnly) {
            const entry = BUNDLED_TEMPLATES.find((item) => item.name === name);
            if (entry === undefined) throw new Error(`missing ${name}`);
            const parsed = parseAgentFile(`/bundled/${name}.md`, entry.template, 'bundled');
            expect(parsed.tier).toBe('read');
            expect(parsed.tools).toBeDefined();
            expect(parsed.tools?.includes('file.edit')).toBe(false);
            expect(parsed.tools?.includes('file.write')).toBe(false);
            expect(parsed.tools?.includes('command.run')).toBe(false);
        }
    });
});
