import { describe, expect, it } from 'vitest';
import { readLocalSessionReplay } from './local-session-store';
import {
    sessionStartedEvent,
    sessionStoppedEvent,
    tempDataDir,
    writeLegacyJsonl,
    writeLegacySource,
} from './local-session-store-test-support';
import { readFile } from 'node:fs/promises';

describe('local session store legacy JSONL compatibility', () => {
    it('reads legacy JSONL-only sessions through the compatibility path without deleting the source', async () => {
        // Given: a legacy JSONL session exists before the SQLite store is opened.
        const dataDir = await tempDataDir('legacy');
        const sessionId = 'session_legacy_jsonl_core';
        const legacyPath = await writeLegacyJsonl(dataDir, sessionId, [
            { eventId: 'event_legacy_started', sequence: 0, event: sessionStartedEvent(sessionId) },
            { eventId: 'event_legacy_stopped', sequence: 1, event: sessionStoppedEvent(sessionId) },
        ]);
        const before = await readFile(legacyPath, 'utf8');

        // When: core reads the session through the local read API.
        const result = await readLocalSessionReplay({ dataDir, sessionId });
        const after = await readFile(legacyPath, 'utf8');

        // Then: legacy events are projected and the source bytes remain untouched.
        expect(result.kind).toBe('found');
        expect(result.kind === 'found' ? result.replay.projection.events.map((event) => event.type) : []).toEqual([
            'session.started',
            'session.stopped',
        ]);
        expect(after).toBe(before);
    });

    it('returns malformed legacy JSONL diagnostics when no SQLite-native session exists', async () => {
        // Given: a legacy JSONL file has an invalid header and no native SQLite rows exist.
        const dataDir = await tempDataDir('malformed');
        const sessionId = 'session_malformed_jsonl_core';
        await writeLegacySource(dataDir, sessionId, '{not json}\n');

        // When: core reads the session through the local read API.
        const result = await readLocalSessionReplay({ dataDir, sessionId });

        // Then: the legacy fallback fails closed with a replay diagnostic.
        expect(result.kind).toBe('found');
        expect(result.kind === 'found' ? result.replay.projection.events : []).toEqual([]);
        expect(result.kind === 'found' ? result.replay.diagnostics : []).toEqual([
            { code: 'corrupt_trailing_record', lineNumber: 1, sessionId },
        ]);
    });
});
