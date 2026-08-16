import type { PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../tools/tool-registry';
import type { ToolRegistration } from '../../tools/tool-registry-types';
import { PLANNER_READONLY_POLICIES } from '../planner-workflow-graph';
import { createModeToolInvocationPolicy } from './mode-tool-policy';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const writeRegistration: ToolRegistration<{ readonly path: string; readonly content: string }, { readonly ok: true }> =
    {
        name: 'file.write',
        description: 'Write a file (test double for the production write tool).',
        capabilityClasses: ['write'],
        parametersJsonSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        outputSchema: z.object({ ok: z.literal(true) }),
        outputLimit: { maxModelOutputChars: 2000 },
        execute: async () => ({ ok: true }),
        toModelOutput: () => 'written',
    };

const probeRegistration: ToolRegistration<{ readonly note: string }, { readonly ok: true }> = {
    name: 'probe.unsupported',
    description: 'Tool whose arguments carry no policy resource.',
    capabilityClasses: ['network'],
    parametersJsonSchema: {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['note'],
        additionalProperties: false,
    },
    inputSchema: z.object({ note: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    outputLimit: { maxModelOutputChars: 2000 },
    execute: async () => ({ ok: true }),
    toModelOutput: () => 'probed',
};

describe('createModeToolInvocationPolicy — planner-readonly matrix', () => {
    it('denies a write to a source path', async () => {
        const registry = new ToolRegistry(
            createModeToolInvocationPolicy([...PLANNER_READONLY_POLICIES], process.cwd()),
        );
        const advertisement = registry.register(writeRegistration);

        const settlement = await registry.invoke({
            toolCallId: 'call_src',
            toolName: writeRegistration.name,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'src/foo.ts', content: 'x' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('mode policy denied write for file.write');
    });

    it('allows writes to .mc/plans, .mc/specs, and .mc/drafts', async () => {
        const registry = new ToolRegistry(
            createModeToolInvocationPolicy([...PLANNER_READONLY_POLICIES], process.cwd()),
        );
        const advertisement = registry.register(writeRegistration);

        for (const allowedPath of ['.mc/plans/x.md', '.mc/specs/x.md', '.mc/drafts/x.md']) {
            const settlement = await registry.invoke({
                toolCallId: `call_${allowedPath.replaceAll('/', '_')}`,
                toolName: writeRegistration.name,
                advertisedVersion: advertisement.version,
                argumentsJson: JSON.stringify({ path: allowedPath, content: 'x' }),
            });
            expect(settlement.result.status, allowedPath).toBe('completed');
        }
    });

    it('resolves absolute paths against the workspace root before matching', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mode-tool-policy-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'real.ts'), 'x', 'utf8');
            const registry = new ToolRegistry(
                createModeToolInvocationPolicy([...PLANNER_READONLY_POLICIES], workspaceRoot),
            );
            const advertisement = registry.register(writeRegistration);

            const denied = await registry.invoke({
                toolCallId: 'call_abs_src',
                toolName: writeRegistration.name,
                advertisedVersion: advertisement.version,
                argumentsJson: JSON.stringify({ path: join(workspaceRoot, 'src', 'real.ts'), content: 'x' }),
            });
            expect(denied.result.status).toBe('failed');

            const allowed = await registry.invoke({
                toolCallId: 'call_abs_mc',
                toolName: writeRegistration.name,
                advertisedVersion: advertisement.version,
                argumentsJson: JSON.stringify({ path: join(workspaceRoot, '.mc', 'plans', 'y.md'), content: 'x' }),
            });
            expect(allowed.result.status).toBe('completed');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('fails closed for a denied action when the tool carries no recognizable resource', async () => {
        const rules: readonly PolicyEffectRule[] = [{ action: 'network', resource: 'example.com/**', effect: 'deny' }];
        const registry = new ToolRegistry(createModeToolInvocationPolicy(rules, process.cwd()));
        const advertisement = registry.register(probeRegistration);

        const settlement = await registry.invoke({
            toolCallId: 'call_probe',
            toolName: probeRegistration.name,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ note: 'n' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('mode policy denied');
    });

    it('passes tools through untouched when the mode rules do not deny them', async () => {
        const rules: readonly PolicyEffectRule[] = [{ action: 'network', resource: 'example.com/**', effect: 'deny' }];
        const registry = new ToolRegistry(createModeToolInvocationPolicy(rules, process.cwd()));
        const advertisement = registry.register(writeRegistration);

        const settlement = await registry.invoke({
            toolCallId: 'call_unrelated',
            toolName: writeRegistration.name,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'src/anything.ts', content: 'x' }),
        });

        expect(settlement.result.status).toBe('completed');
    });
});
