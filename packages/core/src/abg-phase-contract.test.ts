/**
 * Phase 9 contract test: asserts the Phase 1–8 protocol + runtime additions are real, parse,
 * and are wired through the core barrel. Guards against accidental removal of the new ABG
 * vocabulary (signals, event types, graph, registry, packer, resolver, memory store, replay).
 */
import {
    AbgGraphSpecSchema,
    AbgSignalSchema,
    type AgentEventType,
    AgentEventTypeSchema,
    MissionSchema,
    RUN_STATUSES,
    RunSchema,
} from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    AgentRuntime,
    createCodingAgentGraph,
    createCodingAgentNodeRegistry,
    createSdkModelResolver,
    packContext,
    runAbgGraph,
} from './index.js';

describe('ABG phase contract (Phases 1–8 additions are real + wired)', () => {
    it('AbgSignalSchema parses the escalate/fallback signals added in Phase 1', () => {
        expect(AbgSignalSchema.parse({ type: 'escalate', nodeId: 'n', target: 'supervisor' }).type).toBe('escalate');
        expect(AbgSignalSchema.parse({ type: 'fallback', nodeId: 'n', reason: 'model swap' }).type).toBe('fallback');
    });

    it('AgentEventTypeSchema includes the Phase 1 node.escalated / node.fallback types', () => {
        const values = AgentEventTypeSchema.options as readonly AgentEventType[];
        expect(values).toContain('node.escalated');
        expect(values).toContain('node.fallback');
    });

    it('the coding-agent graph validates as an AbgGraphSpec', () => {
        const graph = createCodingAgentGraph({ model: { providerID: 'local', modelID: 'x' } });
        expect(() => AbgGraphSpecSchema.parse(graph)).not.toThrow();
    });

    it('the Phase 1–8 keystones are exported from the core barrel', () => {
        expect(typeof runAbgGraph).toBe('function');
        expect(typeof createCodingAgentGraph).toBe('function');
        expect(typeof createCodingAgentNodeRegistry).toBe('function');
        expect(typeof packContext).toBe('function');
        expect(typeof createSdkModelResolver).toBe('function');
        expect(AgentRuntime).toBeDefined();
    });

    it('createSdkModelResolver rejects an unsupported provider via SdkModelResolverError', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'openai', apiKey: 'k' });
        expect(() => resolve({ providerID: 'no-such-provider', modelID: 'x' })).toThrow();
    });

    it('Phase 7 Mission + Run schemas parse and the lifecycle is covered', () => {
        const mission = MissionSchema.parse({
            id: 'mission-contract',
            name: 'Contract Agent',
            graphId: 'coding-agent',
            createdAt: '2026-06-16T00:00:00.000Z',
            updatedAt: '2026-06-16T00:00:00.000Z',
        });
        expect(mission.graphId).toBe('coding-agent');
        const run = RunSchema.parse({ id: 'run-contract', missionId: mission.id, status: 'running' });
        expect(run.status).toBe('running');
        expect(RUN_STATUSES).toContain('completed');
        expect(() => RunSchema.parse({ id: 'r', missionId: 'm', status: 'nope' })).toThrow();
    });
});
