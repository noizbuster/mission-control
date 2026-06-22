import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { canSpawn, resolveParentSpawns } from './spawn-policy.js';

const baseParent: AgentDefinition = {
    name: 'supervisor',
    description: 'A supervisor agent.',
    systemPrompt: 'You coordinate work.',
    source: 'bundled',
};

const ENV_KEY = 'MCTRL_BLOCKED_AGENT';
const savedBlockedAgent = process.env[ENV_KEY];

afterEach(() => {
    if (savedBlockedAgent === undefined) {
        delete process.env[ENV_KEY];
    } else {
        process.env[ENV_KEY] = savedBlockedAgent;
    }
});

describe('resolveParentSpawns', () => {
    it('returns [] when parent.spawns is undefined (safe default — deny all)', () => {
        const parent: AgentDefinition = { ...baseParent };
        expect(resolveParentSpawns(parent)).toEqual([]);
    });

    it("returns '*' when parent.spawns is '*'", () => {
        const parent: AgentDefinition = { ...baseParent, spawns: '*' };
        expect(resolveParentSpawns(parent)).toBe('*');
    });

    it('returns the array when parent.spawns is a specific list', () => {
        const parent: AgentDefinition = { ...baseParent, spawns: ['explore', 'oracle'] };
        expect(resolveParentSpawns(parent)).toEqual(['explore', 'oracle']);
    });

    it('returns [] when parent.spawns is an empty array', () => {
        const parent: AgentDefinition = { ...baseParent, spawns: [] };
        expect(resolveParentSpawns(parent)).toEqual([]);
    });
});

describe('canSpawn', () => {
    describe('(a) parent spawns=undefined — deny all', () => {
        const parent: AgentDefinition = { ...baseParent };

        it('denies every child agent name', () => {
            expect(canSpawn(parent, 'explore').allowed).toBe(false);
            expect(canSpawn(parent, 'oracle').allowed).toBe(false);
            expect(canSpawn(parent, 'librarian').allowed).toBe(false);
        });
    });

    describe("(b) parent spawns='*' — allow all except self-recursion", () => {
        const parent: AgentDefinition = { ...baseParent, spawns: '*' };

        it('allows any child agent name', () => {
            expect(canSpawn(parent, 'explore').allowed).toBe(true);
            expect(canSpawn(parent, 'oracle').allowed).toBe(true);
            expect(canSpawn(parent, 'librarian').allowed).toBe(true);
        });

        it('still blocks self-recursion even with wildcard spawns', () => {
            const result = canSpawn(parent, 'explore', {
                parentId: 'session-1',
                childId: 'session-1',
            });
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('self-recursion');
        });
    });

    describe("(c) parent spawns=['explore'] — allowlist", () => {
        const parent: AgentDefinition = { ...baseParent, spawns: ['explore'] };

        it('allows the listed child agent', () => {
            expect(canSpawn(parent, 'explore').allowed).toBe(true);
        });

        it('denies a child agent not in the list', () => {
            const result = canSpawn(parent, 'oracle');
            expect(result.allowed).toBe(false);
        });

        it('allows only listed agents when multiple are specified', () => {
            const multiParent: AgentDefinition = {
                ...baseParent,
                spawns: ['explore', 'oracle', 'librarian'],
            };
            expect(canSpawn(multiParent, 'explore').allowed).toBe(true);
            expect(canSpawn(multiParent, 'oracle').allowed).toBe(true);
            expect(canSpawn(multiParent, 'librarian').allowed).toBe(true);
            expect(canSpawn(multiParent, 'metis').allowed).toBe(false);
        });
    });

    describe('(d) self-recursion prevention — parentId === childId', () => {
        const parent: AgentDefinition = { ...baseParent, spawns: '*' };

        it('denies when parentId equals childId', () => {
            const result = canSpawn(parent, 'explore', {
                parentId: 'agent-instance-1',
                childId: 'agent-instance-1',
            });
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('self-recursion');
        });

        it('allows when parentId and childId differ', () => {
            const result = canSpawn(parent, 'explore', {
                parentId: 'agent-instance-1',
                childId: 'agent-instance-2',
            });
            expect(result.allowed).toBe(true);
        });

        it('does not check self-recursion when parentId is omitted', () => {
            const result = canSpawn(parent, 'explore', { childId: 'agent-instance-1' });
            expect(result.allowed).toBe(true);
        });

        it('does not check self-recursion when childId is omitted', () => {
            const result = canSpawn(parent, 'explore', { parentId: 'agent-instance-1' });
            expect(result.allowed).toBe(true);
        });
    });

    describe('(e) MCTRL_BLOCKED_AGENT env var — global agent-type block', () => {
        const parent: AgentDefinition = { ...baseParent, spawns: '*' };

        it('blocks the agent whose name matches the env var', () => {
            process.env[ENV_KEY] = 'explore';

            const result = canSpawn(parent, 'explore');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('MCTRL_BLOCKED_AGENT');
        });

        it('does not block an agent whose name differs from the env var', () => {
            process.env[ENV_KEY] = 'explore';

            expect(canSpawn(parent, 'oracle').allowed).toBe(true);
        });

        it('does not block anything when the env var is unset', () => {
            delete process.env[ENV_KEY];

            expect(canSpawn(parent, 'explore').allowed).toBe(true);
        });

        it('does not block anything when the env var is an empty string', () => {
            process.env[ENV_KEY] = '';

            expect(canSpawn(parent, 'explore').allowed).toBe(true);
        });

        it('takes priority over the parent spawns allowlist', () => {
            process.env[ENV_KEY] = 'explore';
            const allowlisted: AgentDefinition = { ...baseParent, spawns: ['explore'] };

            const result = canSpawn(allowlisted, 'explore');
            expect(result.allowed).toBe(false);
        });
    });

    describe('evaluation order — first denial wins', () => {
        it('checks self-recursion before the env var', () => {
            process.env[ENV_KEY] = 'explore';

            const result = canSpawn({ ...baseParent, spawns: '*' }, 'explore', {
                parentId: 's-1',
                childId: 's-1',
            });
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('self-recursion');
        });

        it('checks the env var before the spawns allowlist', () => {
            process.env[ENV_KEY] = 'explore';
            const parent: AgentDefinition = { ...baseParent, spawns: ['explore'] };

            const result = canSpawn(parent, 'explore');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('MCTRL_BLOCKED_AGENT');
        });
    });

    describe('reason messages', () => {
        it('provides a human-readable reason on every denial', () => {
            const parent: AgentDefinition = { ...baseParent };
            const result = canSpawn(parent, 'explore');
            expect(result.reason).toBeTypeOf('string');
            expect(result.reason.length).toBeGreaterThan(0);
        });

        it('provides a human-readable reason on every approval', () => {
            const parent: AgentDefinition = { ...baseParent, spawns: '*' };
            const result = canSpawn(parent, 'explore');
            expect(result.reason).toBeTypeOf('string');
            expect(result.reason.length).toBeGreaterThan(0);
        });
    });
});
