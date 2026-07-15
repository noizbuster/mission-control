import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { localSessionDbUrl } from '../memory/local-session-store';
import { tempDataDir } from '../memory/local-session-store-test-support';
import { openLocalLibsqlDb } from './local-libsql-db';

const LEGACY_TIME = '2026-07-15T02:00:00.000Z';
const columnNameSchema = z.object({ name: z.string() });

describe('desktop approval effect schema evolution', () => {
    it('narrowly rebuilds the legacy shape and quarantines legacy settled effects as unknown', async () => {
        // Given: a canonical database whose effect ledger has exactly the shipped legacy shape.
        const dataDir = await tempDataDir('approval-effect-legacy-schema');
        const url = localSessionDbUrl(dataDir);
        const initialized = await openLocalLibsqlDb({ url });
        initialized.close();
        const legacyClient = createClient({ url });
        await legacyClient.execute('DROP TABLE desktop_approval_effects');
        await legacyClient.execute(legacyTableSql);
        await legacyClient.execute({
            sql: 'INSERT INTO sessions (session_id,status,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?)',
            args: ['session_legacy_effect', 'idle', LEGACY_TIME, LEGACY_TIME, LEGACY_TIME],
        });
        await legacyClient.execute({
            sql:
                'INSERT INTO desktop_approval_effects ' +
                '(session_id,approval_id,run_id,tool_call_id,tool_name,arguments_json,workspace_root,state,requested_at,settled_at) ' +
                'VALUES (?,?,?,?,?,?,?,?,?,?)',
            args: [
                'session_legacy_effect',
                'approval_legacy_effect',
                'run_legacy_effect',
                'call_legacy_effect',
                'command.run',
                '{}',
                '/workspace',
                'settled',
                LEGACY_TIME,
                LEGACY_TIME,
            ],
        });
        legacyClient.close();

        // When: the normal opener shape-detects and upgrades that database.
        const reopened = await openLocalLibsqlDb({ url });
        const columns = await reopened.client.execute("PRAGMA table_info('desktop_approval_effects')");
        const row = await reopened.client.execute(
            'SELECT state,execution_token,lease_expires_at,outcome,unknown_at,resolved_at FROM desktop_approval_effects',
        );
        reopened.close();

        // Then: only the expected effect shape changed and ambiguous legacy settlement cannot replay.
        expect(columns.rows.map((column) => columnNameSchema.parse(column).name)).toEqual([
            'session_id',
            'approval_id',
            'run_id',
            'tool_call_id',
            'tool_name',
            'arguments_json',
            'workspace_root',
            'state',
            'execution_token',
            'lease_expires_at',
            'outcome',
            'requested_at',
            'executing_at',
            'settled_at',
            'unknown_at',
            'resolved_at',
        ]);
        expect(row.rows).toEqual([
            {
                state: 'unknown',
                execution_token: 'legacy:session_legacy_effect:approval_legacy_effect',
                lease_expires_at: LEGACY_TIME,
                outcome: null,
                unknown_at: LEGACY_TIME,
                resolved_at: null,
            },
        ]);
    });
});

const legacyTableSql = `
    CREATE TABLE desktop_approval_effects (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (session_id, approval_id)
    )
`;
