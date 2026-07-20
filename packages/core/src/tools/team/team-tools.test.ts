/**
 * Team tools tests (Task 24): create -> send -> task_update -> status -> delete;
 * config-off -> absent; concurrent task_update -> atomic lock.
 *
 * Clean-room test suite written against the public team tool surface. Drives
 * the 12 factories through a recording TeamToolRuntime double over a temp
 * `.omo/teams/` root.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolExecutionContext, ToolRegistration } from '../tool-registry-types';
import {
    buildTeamToolRegistrations,
    createDefaultTeamToolRuntime,
    type MemberSpawnRequest,
    type SpawnedMember,
    TEAM_TOOL_COUNT,
    TEAM_TOOL_NAMES,
    type TeamModeConfig,
    type TeamToolRuntime,
} from './index';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RecordingRuntime extends TeamToolRuntime {
    readonly spawns: MemberSpawnRequest[];
    readonly ids: string[];
}

function createRecordingRuntime(prefix = 'team_test'): RecordingRuntime {
    const spawns: MemberSpawnRequest[] = [];
    const ids: string[] = [];
    let counter = 0;
    const fallback = createDefaultTeamToolRuntime();
    return {
        spawns,
        ids,
        async spawnMember(request): Promise<SpawnedMember> {
            spawns.push(request);
            counter += 1;
            return { sessionId: `${prefix}_member_${counter}` };
        },
        generateTeamRunId(name) {
            counter += 1;
            const id = `${prefix}_${counter}_${name.replace(/[^a-z0-9]+/gi, '_')}`;
            ids.push(id);
            return id;
        },
        now: fallback.now,
    };
}

function ctx(): ToolExecutionContext {
    return { toolCallId: 'tc_test', toolName: 'team_test', signal: new AbortController().signal };
}

function enabledConfig(overrides: Partial<TeamModeConfig> = {}): Partial<TeamModeConfig> {
    return { enabled: true, ...overrides };
}

function findTool(
    registrations: readonly ToolRegistration<unknown, unknown>[],
    name: string,
): ToolRegistration<unknown, unknown> {
    const tool = registrations.find((registration) => registration.name === name);
    if (tool === undefined) throw new Error(`tool not registered: ${name}`);
    return tool;
}

async function call(
    registrations: readonly ToolRegistration<unknown, unknown>[],
    name: string,
    input: unknown,
): Promise<Record<string, unknown>> {
    const tool = findTool(registrations, name);
    const output = await tool.execute(input, ctx());
    return output as Record<string, unknown>;
}

async function firstTeamRunId(registrations: readonly ToolRegistration<unknown, unknown>[]): Promise<string> {
    const list = await call(registrations, 'team_list', {});
    const teams = list['teams'] as { teamRunId: string }[];
    const teamRunId = teams[0]?.teamRunId;
    if (teamRunId === undefined) throw new Error('no team runs found');
    return teamRunId;
}

describe('team tools — config gate', () => {
    it('registers zero tools when team_mode.enabled is false (default)', () => {
        const registrations = buildTeamToolRegistrations({ root: '/tmp/never-used', config: { enabled: false } });
        expect(registrations).toHaveLength(0);
    });

    it('registers all 12 tools when enabled and root is provided', () => {
        const registrations = buildTeamToolRegistrations({
            root: '/tmp/team-root',
            config: enabledConfig(),
            runtime: createRecordingRuntime(),
        });
        expect(registrations).toHaveLength(TEAM_TOOL_COUNT);
        const names = registrations.map((registration) => registration.name);
        for (const expected of TEAM_TOOL_NAMES) {
            expect(names).toContain(expected);
        }
    });

    it('registers zero tools when enabled but root is empty', () => {
        const registrations = buildTeamToolRegistrations({
            root: '',
            config: enabledConfig(),
            runtime: createRecordingRuntime(),
        });
        expect(registrations).toHaveLength(0);
    });

    it('every registration carries the team capability class', () => {
        const registrations = buildTeamToolRegistrations({
            root: '/tmp/team-root',
            config: enabledConfig(),
            runtime: createRecordingRuntime(),
        });
        for (const registration of registrations) {
            expect(registration.capabilityClasses).toContain('team');
        }
    });
});

describe('team tools — full lifecycle (create -> send -> task_update -> status -> delete)', () => {
    let root: string;
    let registrations: readonly ToolRegistration<unknown, unknown>[];
    let runtime: RecordingRuntime;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-team-lifecycle-'));
        runtime = createRecordingRuntime('lifecycle');
        registrations = buildTeamToolRegistrations({ root, config: enabledConfig(), runtime });
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('team_create spawns members and returns a team run id', async () => {
        const output = await call(registrations, 'team_create', {
            spec: {
                name: 'research-squad',
                leadAgentId: 'lead',
                members: [
                    { name: 'lead', kind: 'subagent_type', subagentType: 'deep', role: 'orchestrator' },
                    { name: 'scout', kind: 'category', category: 'explore', prompt: 'Explore the repo.' },
                ],
            },
        });
        expect(output['teamRunId']).toMatch(/^lifecycle_/);
        expect(output['memberCount']).toBe(2);
        const members = output['members'] as { name: string; lifecycle: string }[];
        expect(members.map((member) => member.name).sort()).toEqual(['lead', 'scout']);
        expect(runtime.spawns).toHaveLength(2);
    });

    it('team_send_message appends to the recipient mailbox', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const output = await call(registrations, 'team_send_message', {
            teamRunId,
            from: 'lead',
            to: 'scout',
            body: 'go explore the runtime directory',
        });
        expect(output['deliveredTo']).toEqual(['scout']);
        expect(output['broadcast']).toBe(false);
        expect(String(output['messageId']).length).toBeGreaterThan(0);
    });

    it('team_send_message rejects broadcast from a non-lead member', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        await expect(
            call(registrations, 'team_send_message', { teamRunId, from: 'scout', to: '*', body: 'hi all' }),
        ).rejects.toThrow(/lead-only/);
    });

    it('team_send_message broadcast from lead fans out to active members', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const output = await call(registrations, 'team_send_message', {
            teamRunId,
            from: 'lead',
            to: '*',
            body: 'standup',
        });
        expect(output['broadcast']).toBe(true);
        const deliveredTo = output['deliveredTo'] as string[];
        expect(deliveredTo).toContain('scout');
        expect(deliveredTo).not.toContain('lead');
    });

    it('team_task_create adds an open task to the shared list', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const output = await call(registrations, 'team_task_create', {
            teamRunId,
            title: 'Map the tools directory',
            description: 'Enumerate factories.',
        });
        expect(String(output['taskId'])).toMatch(/^tt_/);
        expect(output['status']).toBe('open');
    });

    it('team_task_update claims an open task atomically for the claimant', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const taskList = await call(registrations, 'team_task_list', { teamRunId });
        const tasks = taskList['tasks'] as { taskId: string }[];
        const taskId = tasks[0]?.taskId;
        expect(taskId).toBeDefined();

        const output = await call(registrations, 'team_task_update', {
            teamRunId,
            taskId,
            status: 'claimed',
            claimant: 'scout',
        });
        expect(output['status']).toBe('claimed');
        expect(output['owner']).toBe('scout');
        expect(output['claimed']).toBe(true);
    });

    it('team_task_update on an already-claimed task fails for a second claimant', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const taskList = await call(registrations, 'team_task_list', { teamRunId, status: 'claimed' });
        const tasks = taskList['tasks'] as { taskId: string }[];
        const taskId = tasks[0]?.taskId;
        expect(taskId).toBeDefined();

        const output = await call(registrations, 'team_task_update', {
            teamRunId,
            taskId,
            status: 'claimed',
            claimant: 'lead',
        });
        expect(String(output['error'])).toMatch(/already claimed/);
        expect(output['status']).toBe('claimed');
    });

    it('team_task_get reads a single task with description + dependencies', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const created = await call(registrations, 'team_task_create', {
            teamRunId,
            title: 'Write summary',
            description: 'Summarise findings.',
            dependencies: ['tt_dep_1'],
        });
        const output = await call(registrations, 'team_task_get', { teamRunId, taskId: created['taskId'] });
        expect(output['found']).toBe(true);
        expect(output['title']).toBe('Write summary');
        expect(output['description']).toBe('Summarise findings.');
        expect(output['dependencies']).toEqual(['tt_dep_1']);
    });

    it('team_status reports members, mailbox unread counts, and task summary', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const output = await call(registrations, 'team_status', { teamRunId });
        expect(output['name']).toBe('research-squad');
        expect(output['lead']).toBe('lead');
        const members = output['members'] as { name: string; unread: number }[];
        expect(members).toHaveLength(2);
        const scout = members.find((member) => member.name === 'scout');
        expect(scout?.unread).toBeGreaterThanOrEqual(2);
        const tasks = output['tasks'] as { claimed: number };
        expect(tasks.claimed).toBeGreaterThanOrEqual(1);
    });

    it('team_shutdown_request + team_approve_shutdown terminates the member', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        await call(registrations, 'team_shutdown_request', {
            teamRunId,
            memberName: 'scout',
            reason: 'done exploring',
        });
        const output = await call(registrations, 'team_approve_shutdown', { teamRunId, memberName: 'scout' });
        expect(output['decision']).toBe('approved');
        expect(output['lifecycle']).toBe('terminated');
    });

    it('team_delete tears down state, mailbox, and task list', async () => {
        const teamRunId = await firstTeamRunId(registrations);
        const output = await call(registrations, 'team_delete', { teamRunId });
        expect(output['status']).toBe('deleted');
        const after = await call(registrations, 'team_list', {});
        const teams = after['teams'] as { teamRunId: string }[];
        expect(teams.find((entry) => entry.teamRunId === teamRunId)).toBeUndefined();
    });
});

describe('team tools — concurrent task_update is atomic', () => {
    let root: string;
    let registrations: readonly ToolRegistration<unknown, unknown>[];

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-team-concurrent-'));
        registrations = buildTeamToolRegistrations({
            root,
            config: enabledConfig(),
            runtime: createRecordingRuntime('concurrent'),
        });
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('exactly one of N concurrent claims wins; the rest see already_claimed', async () => {
        const created = await call(registrations, 'team_create', {
            spec: {
                name: 'race-team',
                members: Array.from({ length: 4 }, (_, index) => ({
                    name: `worker_${index + 1}`,
                    kind: 'subagent_type' as const,
                    subagentType: 'deep',
                })),
            },
        });
        const teamRunId = String(created['teamRunId']);

        const task = await call(registrations, 'team_task_create', { teamRunId, title: 'contended task' });
        const taskId = String(task['taskId']);

        const claimants = ['worker_1', 'worker_2', 'worker_3', 'worker_4'];
        const results = await Promise.all(
            claimants.map((claimant) =>
                call(registrations, 'team_task_update', { teamRunId, taskId, status: 'claimed', claimant }),
            ),
        );

        const wins = results.filter((result) => result['claimed'] === true && result['error'] === undefined);
        const losers = results.filter((result) => /already claimed/.test(String(result['error'] ?? '')));
        expect(wins).toHaveLength(1);
        expect(losers).toHaveLength(claimants.length - 1);

        const persisted = await call(registrations, 'team_task_get', { teamRunId, taskId });
        expect(persisted['status']).toBe('claimed');
        expect(claimants).toContain(persisted['owner']);
    });
});

describe('team tools — clean-room guards', () => {
    it('every source file carries the Clean-room attribution and avoids Bun APIs', async () => {
        const { readFile, readdir } = await import('node:fs/promises');
        const dir = join(process.cwd(), 'packages', 'core', 'src', 'tools', 'team');
        const entries = await readdir(dir);
        for (const entry of entries) {
            if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
            const contents = await readFile(join(dir, entry), 'utf8');
            expect(contents).toMatch(/Clean-room reimplementation/i);
            expect(contents).not.toMatch(/\bBun\./);
        }
    });
});
