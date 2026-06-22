import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { deriveChildPathPolicies, evaluatePathPolicies } from '../../agents/path-policy-derive.js';
import { canSpawn } from '../../agents/spawn-policy.js';

/**
 * Ported from opencode `test/agent/plan-mode-subagent-bypass.test.ts` (issue #26514).
 *
 * In Plan Mode (opencode's `plan` agent), edit/write tools are blocked by the
 * plan agent's permission rules. When the plan agent spawns a subagent via
 * `task`, the subagent must inherit that read-only restriction — otherwise
 * the subagent becomes a security bypass for Plan Mode.
 *
 * mission-control encodes agent-level resource gates as `pathPolicies`
 * (action/resource/effect rules on AgentDefinition). These tests exercise
 * `deriveChildPathPolicies` + `evaluatePathPolicies` (todo 22) and `canSpawn`
 * (todo 27) to confirm the parent agent's path-policy denies reach the child.
 */

const planAgent: AgentDefinition = {
    name: 'plan',
    description: 'Read-only planning agent. Denies all edits.',
    systemPrompt: 'You plan changes without applying them.',
    tier: 'read',
    pathPolicies: [{ action: 'edit', resource: '**', effect: 'deny' }],
    source: 'bundled',
};

const generalAgent: AgentDefinition = {
    name: 'general',
    description: 'A general-purpose subagent with full tool surface.',
    systemPrompt: 'You handle complex searches and multistep tasks.',
    tier: 'write',
    source: 'bundled',
};

const exploreAgent: AgentDefinition = {
    name: 'explore',
    description: 'A read-only exploration subagent.',
    systemPrompt: 'You explore and report findings.',
    tier: 'read',
    source: 'bundled',
};

// A user-defined subagent with no pathPolicies — allow-by-default, the most
// damaging bypass case if the parent's denies do not propagate.
const userSubagent: AgentDefinition = {
    name: 'my_subagent',
    description: 'A user-defined subagent.',
    systemPrompt: 'Custom user-defined behavior.',
    tier: 'write',
    source: 'user',
};

describe('[#26514] plan-mode subagent bypass — parent pathPolicies deny reaches the child', () => {
    it('general subagent spawned from plan mode inherits read-only restriction (edit denied)', () => {
        // Sanity: the plan agent itself blocks edit on any resource.
        expect(evaluatePathPolicies('edit', '/some/file.ts', planAgent.pathPolicies ?? []).effect).toBe('deny');

        const effective = deriveChildPathPolicies(planAgent, generalAgent);

        expect(evaluatePathPolicies('edit', '/some/file.ts', effective).effect).toBe('deny');
        expect(evaluatePathPolicies('edit', '/another/path/index.tsx', effective).effect).toBe('deny');
    });

    it('explore subagent launched from plan mode also stays read-only (deny forwarded regardless of tier)', () => {
        // explore is intrinsically read-only (tier: 'read'), so its tool
        // surface would not include file.edit anyway. The point of this
        // test is defense-in-depth: the parent agent's pathPolicies deny
        // must still be present in the derived child policy list.
        const effective = deriveChildPathPolicies(planAgent, exploreAgent);

        // Structural: the parent's edit:** deny is forwarded.
        const forwardedDeny = effective.find(
            (rule) => rule.action === 'edit' && rule.resource === '**' && rule.effect === 'deny',
        );
        expect(forwardedDeny).toBeDefined();

        // Behavioral: evaluating edit against the derived list resolves to deny.
        expect(evaluatePathPolicies('edit', '/x.ts', effective).effect).toBe('deny');
    });

    it('custom user subagent (no pathPolicies) launched from plan mode does not bypass Plan Mode read-only', () => {
        // The most damaging case: a user-defined subagent with default
        // permissions (no pathPolicies, allow-by-default). The subagent
        // must NOT be able to edit when the parent agent is plan.
        const effective = deriveChildPathPolicies(planAgent, userSubagent);

        expect(evaluatePathPolicies('edit', '/some/file.ts', effective).effect).toBe('deny');
    });
});

describe('[#26700] controller self-restriction — canSpawn and pathPolicies are orthogonal concerns', () => {
    it('controller task:** deny in pathPolicies does not block spawning; canSpawn checks the spawns allowlist only', () => {
        const controller: AgentDefinition = {
            name: 'controller',
            description: 'A controller agent that delegates to executors.',
            systemPrompt: 'You coordinate executors.',
            tier: 'exec',
            spawns: ['executor'],
            pathPolicies: [{ action: 'task', resource: '**', effect: 'deny' }],
            source: 'bundled',
        };
        const executor: AgentDefinition = {
            name: 'executor',
            description: 'An executor subagent.',
            systemPrompt: 'You execute tasks.',
            tier: 'write',
            source: 'bundled',
        };

        // canSpawn gates spawn eligibility via the spawns allowlist; it does
        // not consult pathPolicies. The controller may spawn 'executor'
        // because 'executor' is in its spawns list, regardless of the
        // task:** deny self-restriction.
        const spawnDecision = canSpawn(controller, 'executor');
        expect(spawnDecision.allowed).toBe(true);

        // The controller's task:** deny IS forwarded to the child via
        // deriveChildPathPolicies — the self-restriction flows through as a
        // hard runtime ceiling on the spawned child's resource access.
        const effective = deriveChildPathPolicies(controller, executor);
        expect(evaluatePathPolicies('task', 'executor', effective).effect).toBe('deny');
        expect(evaluatePathPolicies('task', 'any-other-target', effective).effect).toBe('deny');
    });
});

describe('parent deny rules forwarded as hard runtime ceilings', () => {
    it('parent bash:** deny overrides a child bash:** allow (last-match-wins)', () => {
        // The child declares bash:** allow, but the parent denies bash on
        // every resource. deriveChildPathPolicies appends parent denies
        // after child policies, so last-match-wins resolves to deny.
        const parent: AgentDefinition = {
            name: 'sandboxed-parent',
            description: 'A parent that denies bash.',
            systemPrompt: 'You cannot run bash.',
            tier: 'exec',
            pathPolicies: [{ action: 'bash', resource: '**', effect: 'deny' }],
            source: 'bundled',
        };
        const child: AgentDefinition = {
            name: 'bash-capable-child',
            description: 'A child that would normally allow bash.',
            systemPrompt: 'You run bash.',
            tier: 'exec',
            pathPolicies: [{ action: 'bash', resource: '**', effect: 'allow' }],
            source: 'bundled',
        };

        const effective = deriveChildPathPolicies(parent, child);

        // Sanity: the child's own policies alone would allow bash.
        expect(evaluatePathPolicies('bash', '/any', child.pathPolicies ?? []).effect).toBe('allow');

        // After derivation, the forwarded parent deny wins.
        expect(evaluatePathPolicies('bash', '/any', effective).effect).toBe('deny');
    });
});
