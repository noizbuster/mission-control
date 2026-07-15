import { describe, expect, it } from 'vitest';
import { parseAgentFile } from '../agent-parser';
import deep from './deep.md';
import designer from './designer.md';
import explore from './explore.md';
import librarian from './librarian.md';
import oracle from './oracle.md';
import planner from './planner.md';
import quick from './quick.md';
import reasoner from './reasoner.md';
import reviewer from './reviewer.md';

const BUNDLED_TEMPLATES = [
    { name: 'quick', template: quick },
    { name: 'deep', template: deep },
    { name: 'reasoner', template: reasoner },
    { name: 'designer', template: designer },
    { name: 'explore', template: explore },
    { name: 'oracle', template: oracle },
    { name: 'librarian', template: librarian },
    { name: 'planner', template: planner },
    { name: 'reviewer', template: reviewer },
] as const;

describe('bundled agents — parse via parseAgentFile', () => {
    it('covers all 9 bundled categories', () => {
        expect(BUNDLED_TEMPLATES).toHaveLength(9);
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

    it('planner carries the .omo/plans + .omo/notepads write allowlist and broad denies', () => {
        const parsed = parseAgentFile('/bundled/planner.md', planner, 'bundled');
        expect(parsed.pathPolicies).toEqual([
            { action: 'write', resource: '**', effect: 'deny' },
            { action: 'write', resource: '.omo/plans/**', effect: 'allow' },
            { action: 'write', resource: '.omo/notepads/**', effect: 'allow' },
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
