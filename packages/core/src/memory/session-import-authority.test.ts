import { RunSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db';
import { attachRunSessionOwner, settleRunSessionOwner } from '../runtime/mission-run/run-session-owner-store';
import { createRun, readRun } from '../runtime/mission-run/run-store';
import { importLegacySessionCompatibilityWindow } from './session-import';
import { readMissionRunDbRow } from './session-import-test-support';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('legacy Run import continuation authority', () => {
    it('strips imported owner authority before canonical runtime attachment', async () => {
        const fixture = await createFixture('before-runtime');
        const sourceRun = RunSchema.parse({
            id: 'run_import_before_runtime',
            missionId: 'mission_import_before_runtime',
            status: 'running',
            sessionId: 'session_import_before_runtime',
            sessionRunId: 'predictable_attacker_owner',
            prompt: 'preserve this prompt',
            childSessionIds: ['child_compatibility'],
        });
        await writeFile(fixture.runPath, JSON.stringify(sourceRun), 'utf8');
        const opened = await openCanonicalRuntimeDb({ dataDir: fixture.dataDir, sessionControlMaintenance: false });

        try {
            const imported = await importLegacySessionCompatibilityWindow({
                ...opened.runtime,
                dataDir: fixture.dataDir,
                omoRoot: fixture.omoDir,
            });
            const canonical = await readRun(fixture.location, sourceRun.id);

            expect(canonical).toMatchObject({
                sessionId: sourceRun.sessionId,
                prompt: sourceRun.prompt,
                childSessionIds: sourceRun.childSessionIds,
            });
            expect(canonical.sessionRunId).toBeUndefined();
            expect(imported.diagnostics).toContainEqual(
                expect.objectContaining({ code: 'session_owner_stripped', runId: sourceRun.id }),
            );

            const attached = await attachRunSessionOwner(fixture.location, sourceRun.id, {
                sessionId: 'session_import_before_runtime',
                sessionRunId: 'canonical_runtime_owner',
            });
            expect(attached.sessionRunId).toBe('canonical_runtime_owner');
            expect(await readFile(fixture.runPath, 'utf8')).toContain('predictable_attacker_owner');
        } finally {
            opened.runtime.close();
        }
    });

    it('cannot overwrite canonical owner or status when imported after runtime settlement', async () => {
        const fixture = await createFixture('after-runtime');
        const canonical = await createRun(
            fixture.location,
            RunSchema.parse({
                id: 'run_import_after_runtime',
                missionId: 'mission_canonical',
                status: 'running',
                sessionId: 'session_import_after_runtime',
            }),
        );
        await settleRunSessionOwner(
            fixture.location,
            canonical.id,
            { sessionId: 'session_import_after_runtime', sessionRunId: 'canonical_runtime_owner' },
            { status: 'blocked' },
        );
        await writeFile(
            fixture.runPath,
            JSON.stringify({
                ...canonical,
                missionId: 'mission_attacker',
                status: 'completed',
                sessionRunId: 'predictable_attacker_owner',
            }),
            'utf8',
        );
        const opened = await openCanonicalRuntimeDb({ dataDir: fixture.dataDir, sessionControlMaintenance: false });

        try {
            const imported = await importLegacySessionCompatibilityWindow({
                ...opened.runtime,
                dataDir: fixture.dataDir,
                omoRoot: fixture.omoDir,
            });
            const persisted = await readRun(fixture.location, canonical.id);

            expect(imported.importedRunCount).toBe(0);
            expect(persisted).toMatchObject({
                missionId: 'mission_canonical',
                status: 'blocked',
                sessionRunId: 'canonical_runtime_owner',
            });
        } finally {
            opened.runtime.close();
        }
    });

    it('redacts imported terminal reasons before storing passthrough data', async () => {
        const fixture = await createFixture('redacted');
        const credential = ['legacy', 'run', 'credential'].join('_');
        const sourceRun = RunSchema.parse({
            id: 'run_import_redacted',
            missionId: 'mission_import_redacted',
            status: 'failed',
            sessionId: 'session_import_redacted',
            sessionRunId: 'predictable_attacker_owner',
            prompt: `run with ${credential}`,
            terminalReason: `failed with ${credential}`,
            endedAt: '2026-07-13T00:00:00.000Z',
        });
        await writeFile(fixture.runPath, JSON.stringify(sourceRun), 'utf8');
        const opened = await openCanonicalRuntimeDb({ dataDir: fixture.dataDir, sessionControlMaintenance: false });

        try {
            await importLegacySessionCompatibilityWindow({
                ...opened.runtime,
                dataDir: fixture.dataDir,
                omoRoot: fixture.omoDir,
                observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
            });
            const row = await readMissionRunDbRow(opened.runtime.client, sourceRun.id);
            const persisted = RunSchema.parse(JSON.parse(String(Reflect.get(row, 'passthrough_json'))));

            expect(persisted.sessionRunId).toBeUndefined();
            expect(JSON.stringify(persisted)).not.toContain(credential);
            expect(persisted.terminalReason).toContain('[REDACTED_CREDENTIAL]');
            expect(persisted.prompt).toContain('[REDACTED_CREDENTIAL]');
            expect(await readFile(fixture.runPath, 'utf8')).toContain(credential);
        } finally {
            opened.runtime.close();
        }
    });
});

async function createFixture(suffix: string) {
    const root = await mkdtemp(join(tmpdir(), `mission-control-import-authority-${suffix}-`));
    tempRoots.push(root);
    const dataDir = join(root, 'data');
    const omoDir = join(root, '.omo');
    const runsDir = join(omoDir, 'runs');
    await mkdir(runsDir, { recursive: true });
    return {
        dataDir,
        omoDir,
        runPath: join(runsDir, `run_import_${suffix.replaceAll('-', '_')}.json`),
        location: { omoRoot: root, dataDir },
    };
}
