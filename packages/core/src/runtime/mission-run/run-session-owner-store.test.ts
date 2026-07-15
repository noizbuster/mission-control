import { RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, seedOmoRoot } from './mission-run-test-support';
import { attachRunSessionOwner, settleRunSessionOwner } from './run-session-owner-store';
import { createRun, readRun, updateRunStatus } from './run-store';

describe('Run session owner attachment', () => {
    it.each([
        { status: 'blocked' },
        { status: 'completed' },
        { status: 'failed', reason: 'owner failed' },
        { status: 'cancelled', reason: 'owner cancelled' },
    ] as const)('atomically attaches the owner while settling as $status', async (settlement) => {
        const fixture = await runningRun(`session_atomic_${settlement.status}`);

        const settled = await settleRunSessionOwner(
            fixture.location,
            fixture.runId,
            {
                sessionId: `session_atomic_${settlement.status}`,
                sessionRunId: `owner_atomic_${settlement.status}`,
            },
            settlement,
        );

        expect(settled.status).toBe(settlement.status);
        expect(settled.sessionRunId).toBe(`owner_atomic_${settlement.status}`);
        expect(await readRun(fixture.location, fixture.runId)).toEqual(settled);
    });

    it.each([
        'blocked',
        'completed',
        'failed',
        'cancelled',
    ] as const)('retains the attached owner through a %s outcome', async (status) => {
        const fixture = await runningRun('session_outcome');

        await attachRunSessionOwner(fixture.location, fixture.runId, {
            sessionId: 'session_outcome',
            sessionRunId: 'owner_outcome',
        });
        await updateRunStatus(fixture.location, fixture.runId, status);

        expect((await readRun(fixture.location, fixture.runId)).sessionRunId).toBe('owner_outcome');
    });

    it('treats a duplicate receipt from the same owner as an idempotent attachment', async () => {
        const fixture = await runningRun('session_duplicate');
        const attachment = { sessionId: 'session_duplicate', sessionRunId: 'owner_duplicate' } as const;

        const first = await attachRunSessionOwner(fixture.location, fixture.runId, attachment);
        const duplicate = await attachRunSessionOwner(fixture.location, fixture.runId, attachment);

        expect(duplicate).toEqual(first);
        expect(duplicate.sessionRunId).toBe('owner_duplicate');
    });

    it('atomically rejects a different owner without overwriting the first receipt', async () => {
        const fixture = await runningRun('session_mismatch');

        const outcomes = await Promise.allSettled([
            attachRunSessionOwner(fixture.location, fixture.runId, {
                sessionId: 'session_mismatch',
                sessionRunId: 'owner_first',
            }),
            attachRunSessionOwner(fixture.location, fixture.runId, {
                sessionId: 'session_mismatch',
                sessionRunId: 'owner_second',
            }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
            reason: { code: 'run_session_owner_mismatch' },
        });
        expect(['owner_first', 'owner_second']).toContain(
            (await readRun(fixture.location, fixture.runId)).sessionRunId,
        );
    });

    it('rejects a receipt for a different durable session', async () => {
        const fixture = await runningRun('session_expected');

        await expect(
            attachRunSessionOwner(fixture.location, fixture.runId, {
                sessionId: 'session_other',
                sessionRunId: 'owner_other_session',
            }),
        ).rejects.toMatchObject({ code: 'run_session_mismatch' });
        expect((await readRun(fixture.location, fixture.runId)).sessionRunId).toBeUndefined();
    });

    it('does not let a newer plain receipt claim an already blocked workflow Run', async () => {
        const fixture = await runningRun('session_plain_mismatch');
        await updateRunStatus(fixture.location, fixture.runId, 'blocked');

        await expect(
            attachRunSessionOwner(fixture.location, fixture.runId, {
                sessionId: 'session_plain_mismatch',
                sessionRunId: 'owner_newer_plain',
            }),
        ).rejects.toMatchObject({ code: 'run_session_owner_not_attachable' });
        expect((await readRun(fixture.location, fixture.runId)).sessionRunId).toBeUndefined();
    });

    it('allows only one concurrent owner settlement to win', async () => {
        const fixture = await runningRun('session_atomic_race');

        const outcomes = await Promise.allSettled([
            settleRunSessionOwner(
                fixture.location,
                fixture.runId,
                { sessionId: 'session_atomic_race', sessionRunId: 'owner_atomic_first' },
                { status: 'blocked' },
            ),
            settleRunSessionOwner(
                fixture.location,
                fixture.runId,
                { sessionId: 'session_atomic_race', sessionRunId: 'owner_atomic_second' },
                { status: 'blocked' },
            ),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
            reason: { code: 'run_session_owner_mismatch' },
        });
        expect((await readRun(fixture.location, fixture.runId)).status).toBe('blocked');
    });
});

async function runningRun(sessionId: string) {
    const location = seedOmoRoot(makeTempRoot());
    const pending = await createRun(
        location,
        RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: 'mission-owner-link',
            status: 'pending',
            sessionId,
        }),
    );
    await updateRunStatus(location, pending.id, 'running');
    return { location, runId: pending.id };
}
