import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import { ensureSessionWithIdentity } from './session-identity-sql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function openTempDb() {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-session-identity-'));
    tempDirs.push(dir);
    return openLocalLibsqlDb({ url: `file:${join(dir, 'mission-control.db')}` });
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ensureSessionWithIdentity', () => {
    it('writes title, category, and agent_name on a new session row', async () => {
        const db = await openTempDb();
        try {
            await ensureSessionWithIdentity({
                client: db.client,
                sessionId: 'ses_child_1',
                now: '2026-07-21T00:00:00.000Z',
                title: 'Investigate auth',
                category: 'deep',
                agentName: 'deep',
                parentSessionId: 'ses_parent',
            });

            const rows = await db.client.execute({
                sql: 'SELECT title, category, agent_name, parent_session_id FROM sessions WHERE session_id = ?',
                args: ['ses_child_1'],
            });
            expect(rows.rows).toEqual([
                {
                    title: 'Investigate auth',
                    category: 'deep',
                    agent_name: 'deep',
                    parent_session_id: 'ses_parent',
                },
            ]);
        } finally {
            db.close();
        }
    });

    it('COALESCE preserves existing identity fields when later patch omits them', async () => {
        const db = await openTempDb();
        try {
            await ensureSessionWithIdentity({
                client: db.client,
                sessionId: 'ses_child_2',
                now: '2026-07-21T00:00:00.000Z',
                title: 'First title',
                category: 'deep',
                agentName: 'deep',
            });
            await ensureSessionWithIdentity({
                client: db.client,
                sessionId: 'ses_child_2',
                now: '2026-07-21T00:01:00.000Z',
                agentName: 'deep-renamed',
            });

            const rows = await db.client.execute({
                sql: 'SELECT title, category, agent_name FROM sessions WHERE session_id = ?',
                args: ['ses_child_2'],
            });
            expect(rows.rows).toEqual([
                {
                    title: 'First title',
                    category: 'deep',
                    agent_name: 'deep-renamed',
                },
            ]);
        } finally {
            db.close();
        }
    });
});
