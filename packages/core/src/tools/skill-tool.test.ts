import type { Skill } from '@mission-control/core';
import { ToolExecutionError, ToolRegistry } from '@mission-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillToolRegistration } from './skill-tool.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

async function makeTempArea(): Promise<{ readonly root: string; readonly skillDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'skill-tool-test-'));
    const skillDir = join(root, 'skills', 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    return { root, skillDir };
}

async function writeSkillFile(dir: string, name: string, description: string, body: string): Promise<string> {
    const filePath = join(dir, 'SKILL.md');
    const content = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
    await writeFile(filePath, content, 'utf8');
    return filePath;
}

function makeSkill(name: string, filePath: string, description = `${name} skill.`): Skill {
    return {
        name,
        description,
        disableModelInvocation: false,
        filePath,
        baseDir: dirname(filePath),
        sourceInfo: { scope: 'project', scopeId: 'project-mctrl', sourceDir: dirname(dirname(filePath)) },
    };
}

function toolContext() {
    return { toolCallId: 'tc1', toolName: 'skill', signal: new AbortController().signal };
}

describe('skill tool', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('returns the wrapped skill body when the name is known', async () => {
        const area = await makeTempArea();
        tempRoots.push(area.root);
        const filePath = await writeSkillFile(
            area.skillDir,
            'demo-skill',
            'A demo skill.',
            'Do the thing.\nDo it well.',
        );
        const skills: readonly Skill[] = [makeSkill('demo-skill', filePath)];
        const registration = createSkillToolRegistration({ skills });

        const output = await registration.execute({ name: 'demo-skill' }, toolContext());

        expect(output.name).toBe('demo-skill');
        expect(output.location).toBe(filePath);
        expect(output.content).toContain('name: demo-skill');
        expect(output.content).toContain('Do the thing.');

        const modelOutput = registration.toModelOutput?.(output) ?? '';
        expect(modelOutput).toContain('<skill-instruction name="demo-skill">');
        expect(modelOutput).toContain(`Skill source: ${filePath}`);
        expect(modelOutput).toContain('reference guidance loaded from a skill file');
        expect(modelOutput).toContain('Do the thing.');
        expect(modelOutput).toContain('</skill-instruction>');
    });

    it('throws a non-retryable ToolExecutionError for an unknown skill name', async () => {
        const area = await makeTempArea();
        tempRoots.push(area.root);
        const filePath = await writeSkillFile(area.skillDir, 'demo-skill', 'A demo skill.', 'body');
        const skills: readonly Skill[] = [makeSkill('demo-skill', filePath)];
        const registration = createSkillToolRegistration({ skills });

        try {
            await registration.execute({ name: 'nonexistent' }, toolContext());
            expect.fail('should have thrown');
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ToolExecutionError);
            const tee = error as ToolExecutionError;
            expect(tee.error.retryable).toBe(false);
            expect(tee.error.message).toContain('unknown skill');
            expect(tee.error.message).toContain('nonexistent');
        }
    });

    it('throws a non-retryable error when the skill file cannot be read', async () => {
        const area = await makeTempArea();
        tempRoots.push(area.root);
        const filePath = join(area.skillDir, 'SKILL.md');
        const skills: readonly Skill[] = [makeSkill('ghost-skill', filePath)];
        const registration = createSkillToolRegistration({ skills });

        try {
            await registration.execute({ name: 'ghost-skill' }, toolContext());
            expect.fail('should have thrown');
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ToolExecutionError);
            const tee = error as ToolExecutionError;
            expect(tee.error.retryable).toBe(false);
            expect(tee.error.message).toContain('failed to read skill');
        }
    });

    it('registers and invokes through a ToolRegistry', async () => {
        const area = await makeTempArea();
        tempRoots.push(area.root);
        const filePath = await writeSkillFile(area.skillDir, 'demo-skill', 'A demo skill.', 'Body via registry.');
        const skills: readonly Skill[] = [makeSkill('demo-skill', filePath)];

        const registry = new ToolRegistry();
        registry.register(createSkillToolRegistration({ skills }));

        const advertised = registry.advertise().find((ad) => ad.name === 'skill');
        expect(advertised).toBeDefined();
        expect(advertised?.capabilityClasses).toContain('read');
        expect(advertised?.guideline).toBeDefined();

        const settlement = await registry.invoke({
            toolCallId: 'tc4',
            toolName: 'skill',
            advertisedVersion: advertised?.version ?? '',
            argumentsJson: JSON.stringify({ name: 'demo-skill' }),
        });
        expect(settlement.result.status).toBe('completed');
        if (settlement.modelOutput !== undefined) {
            expect(settlement.modelOutput.content).toContain('Body via registry.');
        }
    });

    it('returns a failed settlement through the registry for unknown skills', async () => {
        const area = await makeTempArea();
        tempRoots.push(area.root);
        const skills: readonly Skill[] = [];
        const registry = new ToolRegistry();
        registry.register(createSkillToolRegistration({ skills }));

        const advertised = registry.advertise().find((ad) => ad.name === 'skill');
        if (advertised === undefined) {
            expect.fail('skill tool was not registered');
            return;
        }
        const settlement = await registry.invoke({
            toolCallId: 'tc5',
            toolName: 'skill',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ name: 'nope' }),
        });
        expect(settlement.result.status).toBe('failed');
        if (settlement.result.status === 'failed' && settlement.result.error !== undefined) {
            expect(settlement.result.error.retryable).toBe(false);
            expect(settlement.result.error.message).toContain('unknown skill');
        }
    });
});
