import { RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, seedOmoRoot } from './mission-run-test-support.js';
import { attachRunSessionOwner } from './run-session-owner-store.js';
import { createRun, readRun, runFilePath } from './run-store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

describe('Run owner authority boundaries', () => {
    it('strips owner authority during implicit .omo compatibility import', async () => {
        const location = seedOmoRoot(makeTempRoot());
        const run = RunSchema.parse({
            id: 'implicit_imported_owner',
            missionId: 'malicious_inline_mission',
            status: 'blocked',
            sessionId: 'session_implicit_import',
            sessionRunId: 'predictable_attacker_owner',
            prompt: 'preserved compatibility prompt',
            childSessionIds: ['preserved_child'],
        });
        const filePath = runFilePath(location.omoRoot, run.id);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(run), 'utf8');

        const imported = await readRun(location, run.id);
        const canonical = await readRun(location, run.id);

        expect(imported.sessionRunId).toBeUndefined();
        expect(canonical).toMatchObject({
            sessionId: run.sessionId,
            prompt: run.prompt,
            childSessionIds: run.childSessionIds,
        });
        expect(canonical.sessionRunId).toBeUndefined();
    });

    it('allows only the owner attachment seam to persist a runtime owner identity', async () => {
        const location = seedOmoRoot(makeTempRoot());
        const created = await createRun(
            location,
            RunSchema.parse({
                id: 'runtime_owner_boundary',
                missionId: 'runtime_owner_mission',
                status: 'running',
                sessionId: 'session_runtime_owner',
                sessionRunId: 'caller_supplied_owner',
            }),
        );

        expect(created.sessionRunId).toBeUndefined();

        const attached = await attachRunSessionOwner(location, created.id, {
            sessionId: 'session_runtime_owner',
            sessionRunId: 'canonical_runtime_owner',
        });

        expect(attached.sessionRunId).toBe('canonical_runtime_owner');
        expect((await readRun(location, created.id)).sessionRunId).toBe('canonical_runtime_owner');
    });

    it('rejects duplicate creation without erasing canonical owner or status', async () => {
        const location = seedOmoRoot(makeTempRoot());
        const created = await createRun(
            location,
            RunSchema.parse({
                id: 'duplicate_runtime_owner_boundary',
                missionId: 'canonical_mission',
                status: 'running',
                sessionId: 'session_duplicate_runtime_owner',
            }),
        );
        await attachRunSessionOwner(location, created.id, {
            sessionId: 'session_duplicate_runtime_owner',
            sessionRunId: 'canonical_runtime_owner',
        });

        await expect(
            createRun(
                location,
                RunSchema.parse({
                    id: created.id,
                    missionId: 'attacker_mission',
                    status: 'completed',
                    sessionId: 'session_duplicate_runtime_owner',
                    sessionRunId: 'attacker_owner',
                }),
            ),
        ).rejects.toMatchObject({ code: 'run_exists' });
        expect(await readRun(location, created.id)).toMatchObject({
            missionId: 'canonical_mission',
            status: 'running',
            sessionRunId: 'canonical_runtime_owner',
        });
    });
});
