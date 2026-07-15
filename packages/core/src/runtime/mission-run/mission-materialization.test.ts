import { MissionSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { materializeMission } from './mission-run-service';
import { makeCategorizedWorkflowSpec, makeTestWorkflowSpec } from './mission-run-test-support';

describe('materializeMission', () => {
    it('creates a valid draft Mission from a WorkflowSpec', () => {
        const mission = materializeMission(makeTestWorkflowSpec());

        expect(mission.id).toHaveLength(36);
        expect(mission.name).toBe('test-workflow');
        expect(mission.description).toBe('A test workflow');
        expect(mission.status).toBe('draft');
        expect(mission.graph?.id).toBe('test-graph');
        expect(mission.workflowName).toBe('test-workflow');
        expect(mission.createdAt).toBeDefined();
        expect(mission.updatedAt).toBeDefined();
        expect(mission.capabilities).toEqual({ allow: [], deny: [] });
        expect(() => MissionSchema.parse(mission)).not.toThrow();
    });

    it('derives capabilities from categories and mode declarations from modes', () => {
        const mission = materializeMission(makeCategorizedWorkflowSpec());

        expect(mission.capabilities.allow).toContain('read');
        expect(mission.capabilities.allow).toContain('edit');
        expect(mission.modeDeclarations).toEqual([{ modeId: 'autopilot', active: true }]);
    });

    it('generates unique ids on repeated calls', () => {
        const spec = makeTestWorkflowSpec();

        expect(materializeMission(spec).id).not.toBe(materializeMission(spec).id);
    });
});
