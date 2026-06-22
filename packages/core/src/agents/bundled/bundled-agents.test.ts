import { describe, expect, it } from 'vitest';
import { parseAgentFile } from '../agent-parser.js';
import deep from './deep.md.js';
import explore from './explore.md.js';
import librarian from './librarian.md.js';
import metis from './metis.md.js';
import momus from './momus.md.js';
import oracle from './oracle.md.js';
import quick from './quick.md.js';
import ultrabrain from './ultrabrain.md.js';
import visualEngineering from './visual-engineering.md.js';

const BUNDLED_TEMPLATES = [
    { name: 'quick', template: quick },
    { name: 'deep', template: deep },
    { name: 'ultrabrain', template: ultrabrain },
    { name: 'visual-engineering', template: visualEngineering },
    { name: 'explore', template: explore },
    { name: 'oracle', template: oracle },
    { name: 'librarian', template: librarian },
    { name: 'metis', template: metis },
    { name: 'momus', template: momus },
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

    it('metis carries the .omo/plans + .omo/notepads write allowlist and broad denies', () => {
        const parsed = parseAgentFile('/bundled/metis.md', metis, 'bundled');
        expect(parsed.pathPolicies).toEqual([
            { action: 'write', resource: '**', effect: 'deny' },
            { action: 'write', resource: '.omo/plans/**', effect: 'allow' },
            { action: 'write', resource: '.omo/notepads/**', effect: 'allow' },
            { action: 'edit', resource: '**', effect: 'deny' },
            { action: 'patch', resource: '**', effect: 'deny' },
            { action: 'bash', resource: '**', effect: 'deny' },
        ]);
    });

    it('read-only categories (explore, oracle, librarian, momus) omit write/edit tools', () => {
        const readOnly = ['explore', 'oracle', 'librarian', 'momus'];
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
