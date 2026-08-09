import { afterEach, describe, expect, it } from 'vitest';
import type { TeamSpec } from './team-schemas';
import {
    buildInitialState,
    deleteTeam,
    readState,
    updateState,
    writeConfig,
    writeState,
} from './team-store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-team-store-'));
    roots.push(root);
    return root;
}

function sampleSpec(): TeamSpec {
    return {
        name: 'race-squad',
        leadAgentId: 'lead',
        members: [
            { name: 'lead', kind: 'subagent_type', subagentType: 'deep', role: 'orchestrator' },
            { name: 'scout', kind: 'category', category: 'explore', prompt: 'Explore the repo.' },
        ],
    };
}

describe('team-store concurrency', () => {
    it('serializes concurrent updateState patches without dropping fields', async () => {
        const root = await tempRoot();
        const teamRunId = 'team_race_1';
        const spec = sampleSpec();
        await writeConfig(root, teamRunId, spec);
        await writeState(root, buildInitialState(teamRunId, spec, 'ses_lead'));
        await Promise.all([
            updateState(root, teamRunId, (state) => ({
                ...state,
                leadSessionId: 'ses_lead_b',
            })),
            updateState(root, teamRunId, (state) => ({
                ...state,
                members: state.members.map((member) =>
                    member.name === 'scout' ? { ...member, lifecycle: 'active' } : member,
                ),
            })),
        ]);
        const state = await readState(root, teamRunId);
        expect(state.leadSessionId).toBe('ses_lead_b');
        expect(state.members.find((member) => member.name === 'scout')?.lifecycle).toBe('active');
    });

    it('serializes deleteTeam against in-flight updateState', async () => {
        const root = await tempRoot();
        const teamRunId = 'team_race_2';
        const spec = sampleSpec();
        await writeConfig(root, teamRunId, spec);
        await writeState(root, buildInitialState(teamRunId, spec, 'ses_lead'));
        const update = updateState(root, teamRunId, (state) => ({
            ...state,
            leadSessionId: 'ses_after',
        }));
        const deleted = deleteTeam(root, teamRunId);
        await Promise.all([update, deleted]);
        await expect(readState(root, teamRunId)).rejects.toMatchObject({ code: 'team_not_found' });
    });
});
