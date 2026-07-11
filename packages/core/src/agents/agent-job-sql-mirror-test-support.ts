import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { SqlAgentJobMirror } from './agent-job-sql-mirror.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
export const agentJobTestNow = '2026-07-06T00:00:00.000Z';

export function cleanupAgentJobMirrorTests(): void {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function withAgentJobMirror<T>(run: (mirror: SqlAgentJobMirror) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'mctrl-agent-job-db-'));
    tempDirs.push(dir);
    const runtime = await openLocalLibsqlDb({ url: `file:${join(dir, 'session.sqlite')}` });
    try {
        return await run(await SqlAgentJobMirror.create(runtime));
    } finally {
        runtime.close();
    }
}

export async function insertAgentJobTestSession(mirror: SqlAgentJobMirror, sessionId: string): Promise<void> {
    await mirror.client.execute({
        sql:
            'INSERT INTO sessions ' +
            '(session_id, status, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?)',
        args: [sessionId, 'running', agentJobTestNow, agentJobTestNow, agentJobTestNow],
    });
}
