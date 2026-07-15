import { JsonlSessionEventStore } from './memory/jsonl-session-event-store';
import { SessionAdmissionService } from './session-admission';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export async function cleanupSessionAdmissionTestDirs(): Promise<void> {
    await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
}

export async function openAdmissionContext(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly dataDir: string;
    readonly store: JsonlSessionEventStore;
    readonly service: SessionAdmissionService;
}> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-admission-'));
    tempDirs.push(dataDir);
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: () => '2026-06-06T10:00:00.000Z',
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
    return {
        sessionId,
        dataDir,
        store,
        service: new SessionAdmissionService({
            sessionId,
            store,
            now: () => '2026-06-06T10:00:00.000Z',
        }),
    };
}
