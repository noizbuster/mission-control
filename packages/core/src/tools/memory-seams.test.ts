import {
    BUILTIN_MEMORY_BACKENDS,
    MEMORY_BACKENDS,
    MemoryBackendConfigSchema,
    MemoryBackendIdSchema,
    MemoryBackendSchema,
} from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createLearnToolRegistration, LEARN_TOOL_NAME, registerLearnTool } from './learn-tool';
import {
    createManageSkillToolRegistration,
    MANAGE_SKILL_TOOL_NAME,
    registerManageSkillTool,
} from './manage-skill-tool';
import {
    DeferredMemoryBackend,
    LocalMemoryBackend,
    MEMORY_BACKEND_NOT_CONFIGURED,
    type MemoryBackend,
    resolveMemoryBackend,
} from './memory-backend';
import { createMemoryEditToolRegistration, MEMORY_EDIT_TOOL_NAME, registerMemoryEditTool } from './memory-edit-tool';
import {
    createMemoryRecallToolRegistration,
    RECALL_TOOL_NAME,
    registerMemoryRecallTool,
} from './memory-recall-tool';
import {
    createMemoryReflectToolRegistration,
    REFLECT_TOOL_NAME,
    registerMemoryReflectTool,
} from './memory-reflect-tool';
import {
    createMemoryRetainToolRegistration,
    RETAIN_TOOL_NAME,
    registerMemoryRetainTool,
} from './memory-retain-tool';
import { ToolRegistry } from './tool-registry';

/** All six memory tools and their register helpers, exercised together for gating parity. */
const TOOL_NAMES = [
    RETAIN_TOOL_NAME,
    RECALL_TOOL_NAME,
    REFLECT_TOOL_NAME,
    MEMORY_EDIT_TOOL_NAME,
    LEARN_TOOL_NAME,
    MANAGE_SKILL_TOOL_NAME,
] as const;

function registerAll(registry: ToolRegistry, backend: MemoryBackend): void {
    registerMemoryRetainTool(registry, backend);
    registerMemoryRecallTool(registry, backend);
    registerMemoryReflectTool(registry, backend);
    registerMemoryEditTool(registry, backend);
    registerLearnTool(registry, backend);
    registerManageSkillTool(registry, backend);
}

function advertisedNames(registry: ToolRegistry): string[] {
    return registry.advertise().map((tool) => tool.name);
}

describe('memory tool registration gating', () => {
    it('registers and advertises all six tools when the backend is local', () => {
        const registry = new ToolRegistry();
        registerAll(registry, new LocalMemoryBackend());
        const names = advertisedNames(registry);
        for (const name of TOOL_NAMES) {
            expect(names).toContain(name);
        }
    });

    it('does NOT register or advertise the tools when the backend is off', () => {
        const registry = new ToolRegistry();
        registerAll(registry, resolveMemoryBackend('off'));
        expect(advertisedNames(registry)).toEqual([]);
    });

    it('each register helper returns undefined when the backend is off', () => {
        const registry = new ToolRegistry();
        const off = resolveMemoryBackend('off');
        expect(registerMemoryRetainTool(registry, off)).toBeUndefined();
        expect(registerMemoryRecallTool(registry, off)).toBeUndefined();
        expect(registerMemoryReflectTool(registry, off)).toBeUndefined();
        expect(registerMemoryEditTool(registry, off)).toBeUndefined();
        expect(registerLearnTool(registry, off)).toBeUndefined();
        expect(registerManageSkillTool(registry, off)).toBeUndefined();
    });

    it('registers tools for catalog-only backends (mnemopi/hindsight) so they advertise but defer execution', () => {
        for (const id of ['mnemopi', 'hindsight'] as const) {
            const registry = new ToolRegistry();
            registerAll(registry, resolveMemoryBackend(id));
            const names = advertisedNames(registry);
            for (const name of TOOL_NAMES) {
                expect(names).toContain(name);
            }
        }
    });
});

describe('invoking with an off backend returns memory_backend_not_configured', () => {
    const off = resolveMemoryBackend('off');

    it('retain returns memory_backend_not_configured', async () => {
        const registration = createMemoryRetainToolRegistration(off);
        const output = await registration.execute({ items: [{ content: 'x', context: undefined }] }, execContext());
        expect(output.status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
        expect(output.backend).toBe('off');
    });

    it('recall returns memory_backend_not_configured', async () => {
        const registration = createMemoryRecallToolRegistration(off);
        const output = await registration.execute({ query: 'x' }, execContext());
        expect(output.status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
    });

    it('reflect returns memory_backend_not_configured', async () => {
        const registration = createMemoryReflectToolRegistration(off);
        const output = await registration.execute({ query: 'x', context: undefined }, execContext());
        expect(output.status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
    });

    it('memory_edit returns memory_backend_not_configured', async () => {
        const registration = createMemoryEditToolRegistration(off);
        const output = await registration.execute(
            { op: 'forget', id: 'mem-1', content: undefined, importance: undefined, replacement_id: undefined },
            execContext(),
        );
        expect(output.status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
    });

    it('learn returns memory_backend_not_configured for the lesson path', async () => {
        const registration = createLearnToolRegistration(off);
        const output = await registration.execute(
            { memory: 'lesson', context: undefined, skill: undefined },
            execContext(),
        );
        expect(output.memoryStatus).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
    });
});

describe('local stub: retain -> recall round-trip in memory', () => {
    it('stores memories via retain and retrieves them via recall through the registry invoke path', async () => {
        const backend = new LocalMemoryBackend();
        const registry = new ToolRegistry();
        const retainAd = registerMemoryRetainTool(registry, backend);
        const recallAd = registerMemoryRecallTool(registry, backend);
        if (retainAd === undefined || recallAd === undefined) throw new Error('local must register both tools');

        const retainSettlement = await registry.invoke({
            toolCallId: 'call_retain',
            toolName: RETAIN_TOOL_NAME,
            advertisedVersion: retainAd.version,
            argumentsJson: JSON.stringify({
                items: [
                    { content: 'The deploy script lives in scripts/deploy.sh', context: 'infra' },
                    { content: 'Tests run with pnpm test', context: 'tooling' },
                ],
            }),
        });
        expect(retainSettlement.result.status).toBe('completed');
        expect(retainSettlement.structuredOutput).toMatchObject({ status: 'stored', count: 2, backend: 'local' });

        const recallSettlement = await registry.invoke({
            toolCallId: 'call_recall',
            toolName: RECALL_TOOL_NAME,
            advertisedVersion: recallAd.version,
            argumentsJson: JSON.stringify({ query: 'deploy script' }),
        });
        expect(recallSettlement.result.status).toBe('completed');
        const output = recallSettlement.structuredOutput as {
            status: string;
            count: number;
            memories: { id: string; content: string }[];
        };
        expect(output.status).toBe('ok');
        expect(output.count).toBe(1);
        expect(output.memories[0]?.content).toContain('deploy script');
        expect(output.memories[0]?.id).toMatch(/^mem-\d+$/);
    });

    it('returns empty when recall finds no matching memories', async () => {
        const backend = new LocalMemoryBackend();
        const registry = new ToolRegistry();
        const ad = registerMemoryRecallTool(registry, backend);
        if (ad === undefined) throw new Error('recall must register for local');
        const settlement = await registry.invoke({
            toolCallId: 'call_recall_empty',
            toolName: RECALL_TOOL_NAME,
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({ query: 'nonexistent topic' }),
        });
        const output = settlement.structuredOutput as { status: string; count: number };
        expect(output.status).toBe('empty');
        expect(output.count).toBe(0);
    });

    it('memory_edit update then recall reflects the edited content (single shared Map)', async () => {
        const backend = new LocalMemoryBackend();
        const registry = new ToolRegistry();
        const retainAd = registerMemoryRetainTool(registry, backend);
        const editAd = registerMemoryEditTool(registry, backend);
        const recallAd = registerMemoryRecallTool(registry, backend);
        if (retainAd === undefined || editAd === undefined || recallAd === undefined) {
            throw new Error('local must register retain, edit, and recall');
        }

        await registry.invoke({
            toolCallId: 'c1',
            toolName: RETAIN_TOOL_NAME,
            advertisedVersion: retainAd.version,
            argumentsJson: JSON.stringify({ items: [{ content: 'original fact' }] }),
        });
        const recallBefore = await registry.invoke({
            toolCallId: 'c2',
            toolName: RECALL_TOOL_NAME,
            advertisedVersion: recallAd.version,
            argumentsJson: JSON.stringify({ query: 'fact' }),
        });
        const beforeId = (recallBefore.structuredOutput as { memories: { id: string }[] }).memories[0]?.id;
        expect(beforeId).toBeDefined();

        const editSettlement = await registry.invoke({
            toolCallId: 'c3',
            toolName: MEMORY_EDIT_TOOL_NAME,
            advertisedVersion: editAd.version,
            argumentsJson: JSON.stringify({ op: 'update', id: beforeId, content: 'edited fact' }),
        });
        expect((editSettlement.structuredOutput as { status: string }).status).toBe('updated');

        const recallAfter = await registry.invoke({
            toolCallId: 'c4',
            toolName: RECALL_TOOL_NAME,
            advertisedVersion: recallAd.version,
            argumentsJson: JSON.stringify({ query: 'edited' }),
        });
        const after = recallAfter.structuredOutput as { memories: { content: string }[] };
        expect(after.memories[0]?.content).toBe('edited fact');
    });
});

describe('catalog-only backends register but defer execution', () => {
    it('mnemopi retain returns memory_backend_not_configured through the registry', async () => {
        const backend = resolveMemoryBackend('mnemopi');
        const registry = new ToolRegistry();
        const ad = registerMemoryRetainTool(registry, backend);
        if (ad === undefined) throw new Error('mnemopi must register retain');
        const settlement = await registry.invoke({
            toolCallId: 'call_mnemo',
            toolName: RETAIN_TOOL_NAME,
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({ items: [{ content: 'x' }] }),
        });
        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            status: MEMORY_BACKEND_NOT_CONFIGURED,
            backend: 'mnemopi',
        });
    });
});

describe('manage_skill deferred seam', () => {
    it('returns skill_seam_deferred through the registry', async () => {
        const backend = new LocalMemoryBackend();
        const registry = new ToolRegistry();
        const ad = registerManageSkillTool(registry, backend);
        if (ad === undefined) throw new Error('manage_skill must register for local');
        const settlement = await registry.invoke({
            toolCallId: 'call_skill',
            toolName: MANAGE_SKILL_TOOL_NAME,
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({
                action: 'create',
                name: 'my-skill',
                description: 'when to use it',
                body: '# body',
            }),
        });
        expect((settlement.structuredOutput as { status: string }).status).toBe('skill_seam_deferred');
    });

    it('rejects create/update without description and body (schema refine before execution)', async () => {
        const backend = new LocalMemoryBackend();
        const registry = new ToolRegistry();
        const ad = registerManageSkillTool(registry, backend);
        if (ad === undefined) throw new Error('manage_skill must register for local');
        const settlement = await registry.invoke({
            toolCallId: 'call_skill_bad',
            toolName: MANAGE_SKILL_TOOL_NAME,
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({ action: 'create', name: 'my-skill' }),
        });
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.code).toBe('schema_invalid');
    });
});

describe('protocol MemoryBackend schema', () => {
    it('MEMORY_BACKENDS lists off, local, mnemopi, hindsight', () => {
        expect(MEMORY_BACKENDS).toEqual(['off', 'local', 'mnemopi', 'hindsight']);
    });

    it('MemoryBackendIdSchema parses recognized ids and rejects unknown ones', () => {
        expect(MemoryBackendIdSchema.parse('off')).toBe('off');
        expect(MemoryBackendIdSchema.parse('local')).toBe('local');
        expect(() => MemoryBackendIdSchema.parse('redis')).toThrow();
    });

    it('MemoryBackendConfigSchema defaults to off when backend is absent', () => {
        expect(MemoryBackendConfigSchema.parse({}).backend).toBe('off');
        expect(MemoryBackendConfigSchema.parse({ backend: 'local' }).backend).toBe('local');
    });

    it('MemoryBackendSchema validates a catalog entry and rejects unknown fields', () => {
        const entry = BUILTIN_MEMORY_BACKENDS.find((value) => value.id === 'local');
        expect(entry).toBeDefined();
        expect(MemoryBackendSchema.parse(entry)).toMatchObject({ id: 'local', supported: true });
        expect(() => MemoryBackendSchema.parse({ id: 'local', supported: true })).toThrow();
    });

    it('BUILTIN_MEMORY_BACKENDS marks mnemopi and hindsight as unsupported catalog seams', () => {
        const ids = BUILTIN_MEMORY_BACKENDS.map((value) => value.id);
        expect(ids).toEqual(['off', 'local', 'mnemopi', 'hindsight']);
        const mnemopi = BUILTIN_MEMORY_BACKENDS.find((value) => value.id === 'mnemopi');
        const hindsight = BUILTIN_MEMORY_BACKENDS.find((value) => value.id === 'hindsight');
        expect(mnemopi?.supported).toBe(false);
        expect(hindsight?.supported).toBe(false);
        const local = BUILTIN_MEMORY_BACKENDS.find((value) => value.id === 'local');
        expect(local?.supported).toBe(true);
    });
});

describe('DeferredMemoryBackend', () => {
    it('carries its configured id and returns not_configured for every operation', async () => {
        const backend = new DeferredMemoryBackend('hindsight');
        expect(backend.id).toBe('hindsight');
        expect((await backend.retain([{ content: 'x', context: undefined, importance: undefined }])).status).toBe(
            MEMORY_BACKEND_NOT_CONFIGURED,
        );
        expect((await backend.recall('x')).status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
        expect((await backend.reflect('x')).status).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
        expect(
            (
                await backend.edit({
                    op: 'forget',
                    id: 'x',
                    content: undefined,
                    importance: undefined,
                    replacementId: undefined,
                })
            ).status,
        ).toBe(MEMORY_BACKEND_NOT_CONFIGURED);
    });
});

function execContext(): { toolCallId: string; toolName: string; signal: AbortSignal } {
    return { toolCallId: 'call_test', toolName: 'memory', signal: new AbortController().signal };
}
