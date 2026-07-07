import { describe, expect, it } from 'vitest';
import { JsonlSessionEventStore, JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { createTempDataDir } from './jsonl-session-event-store-test-support.js';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('JsonlSessionEventStore corrupt input', () => {
    it('reports corrupt line diagnostics with the session id and line number', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_corrupt';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        await store.close();
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"not valid json"\n', 'utf8');

        const openCorruptStore = JsonlSessionEventStore.open({ sessionId, dataDir });

        await expect(openCorruptStore).rejects.toBeInstanceOf(JsonlSessionEventStoreError);
        await expect(openCorruptStore).rejects.toMatchObject({
            code: 'corrupt_line',
            sessionId,
            lineNumber: 2,
        });
    });
});
