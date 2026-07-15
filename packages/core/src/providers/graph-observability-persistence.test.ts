import type { AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { projectAbgSignalToEvent } from '../behavior/signals.js';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import { parseJsonlSessionLog } from '../memory/jsonl-session-records.js';
import { exportLegacySessionJsonl } from '../memory/session-import.js';
import { SqliteSessionEventStore } from '../memory/sqlite-session-event-store.js';
import { projectSessionReplay } from '../session-replay.js';
import { createObservabilityRedactor } from './observability-redactor.js';
import { REDACTED_CREDENTIAL } from './redaction-handler.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-07-13T00:00:00.000Z';
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('graph observability persistence redaction', () => {
    it('keeps credential literals out of SQL, JSONL, replay, and export', async () => {
        // Given
        const root = await mkdtemp(join(tmpdir(), 'mission-control-graph-redaction-'));
        tempDirs.push(root);
        const sessionId = 'session_graph_observability_redaction';
        const knownCredential = ['mcp', 'literal', 'header', 'secret'].join('_');
        const patternCredential = ['sk', 'persisted', 'secret123'].join('-');
        const signal: AbgSignal = {
            type: 'emit',
            nodeId: 'llm_actor',
            graphId: 'graph_redaction',
            event: {
                id: 'graph_redaction.llm_actor.tool.completed.1',
                type: 'tool.completed',
                source: 'llm-actor',
                timestamp: NOW,
                payload: {
                    toolCallId: 'call_redaction',
                    toolName: 'command.run',
                    output: `completed ${patternCredential}`,
                    structuredOutput: {
                        headers: { Authorization: `Bearer ${knownCredential}` },
                        command: ['keep-this-command', '--credential', knownCredential],
                    },
                },
            },
        };
        const projectionInput = {
            graphId: 'graph_redaction',
            sessionId,
            timestamp: NOW,
            signal,
        };
        const observabilityRedactor = createObservabilityRedactor({ secrets: [knownCredential] });
        const event = projectAbgSignalToEvent(projectionInput);
        const sqliteUrl = `file:${join(root, 'mission-control.db')}`;
        const runtime = await openLocalLibsqlDb({ url: sqliteUrl });
        const sqlite = SqliteSessionEventStore.fromRuntime(runtime, {
            sessionId,
            now: () => NOW,
            createEventId: () => 'event_graph_redaction',
            observabilityRedactor,
        });
        const jsonlDataDir = join(root, 'jsonl');
        const jsonl = await JsonlSessionEventStore.open({
            sessionId,
            dataDir: jsonlDataDir,
            now: () => NOW,
            createEventId: () => 'event_graph_redaction',
            observabilityRedactor,
        });

        try {
            // When
            await sqlite.append(event);
            await jsonl.append(event);
            const sqlRows = await runtime.client.execute({
                sql: 'SELECT payload_json FROM session_events WHERE session_id = ?',
                args: [sessionId],
            });
            const sqliteReplay = await sqlite.getReplay(sessionId);
            await jsonl.close();
            const jsonlPath = join(jsonlDataDir, 'sessions', `${sessionId}.jsonl`);
            const rawJsonl = await readFile(jsonlPath, 'utf8');
            const parsedJsonl = parseJsonlSessionLog({ sessionId, contents: rawJsonl, filePath: jsonlPath });
            const jsonlReplay = projectSessionReplay({ sessionId, envelopes: parsedJsonl.envelopes });
            const exported = await exportLegacySessionJsonl({
                ...runtime,
                sessionId,
                outputDir: join(root, 'export'),
                now: () => NOW,
                observabilityRedactor,
            });
            const exportedJsonl = await readFile(exported.filePath, 'utf8');
            const surfaces = [
                JSON.stringify(sqlRows.rows),
                JSON.stringify(sqliteReplay),
                JSON.stringify(jsonlReplay),
                rawJsonl,
                exportedJsonl,
            ];

            // Then
            expect(JSON.stringify(signal).includes(knownCredential)).toBe(true);
            expect(JSON.stringify(event).includes(knownCredential)).toBe(true);
            for (const surface of surfaces) {
                expect(surface.includes(REDACTED_CREDENTIAL)).toBe(true);
                expect(surface.includes('keep-this-command')).toBe(true);
                expect(surface.includes(knownCredential)).toBe(false);
                expect(surface.includes(patternCredential)).toBe(false);
            }
        } finally {
            await jsonl.close();
            await sqlite.close();
        }
    });
});
