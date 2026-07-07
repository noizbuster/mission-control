import type { Client } from '@libsql/client';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { type JsonlSessionReplayPrefixProjection, projectSessionReplay } from '../session-replay.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { ensureLocalSessionDatabase } from './local-session-store-database.js';
import { localSessionDbUrl } from './local-session-store-paths.js';
import { readExportEnvelopes } from './session-import-event-sql.js';

export type LocalSessionReplayReadResult =
    | {
          readonly kind: 'found';
          readonly replay: JsonlSessionReplayPrefixProjection;
      }
    | {
          readonly kind: 'missing';
      };

export async function readLocalSessionReplay(input: {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
}): Promise<LocalSessionReplayReadResult> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    await ensureLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(dataDir) });
    try {
        if (await hasSqliteSession(runtime.client, input.sessionId)) {
            const envelopes = await readExportEnvelopes({ client: runtime.client, sessionId: input.sessionId });
            if (envelopes.length > 0) {
                const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes });
                return { kind: 'found', replay: { projection, diagnostics: projection.diagnostics } };
            }
        }
    } finally {
        runtime.close();
    }
    return { kind: 'missing' };
}

async function hasSqliteSession(client: Client, sessionId: string): Promise<boolean> {
    const result = await client.execute({
        sql: 'SELECT session_id FROM sessions WHERE session_id = ? LIMIT 1',
        args: [sessionId],
    });
    return result.rows.length > 0;
}
