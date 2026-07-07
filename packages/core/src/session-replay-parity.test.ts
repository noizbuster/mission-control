import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './memory/jsonl-session-records.js';
import {
    REPLAY_PARITY_SESSION_ID,
    replayParityEvents,
    replayParitySummary,
} from './memory/session-replay-parity-fixtures.js';
import {
    openJsonlReplayParityLedger,
    PlannedSqliteReplayLedgerFake,
    type ReplayParityLedger,
} from './memory/session-replay-parity-test-support.js';
import type { SessionReplayProjection } from './session-replay.js';
import { projectJsonlSessionReplayPrefix } from './session-replay.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('session replay parity contract', () => {
    it('projects JSONL and planned SQLite ledger snapshots from the same ordered fixture sequence', async () => {
        // Given
        const sessionId = REPLAY_PARITY_SESSION_ID;
        const ledgers = await openReplayParityLedgers(sessionId);
        const events = replayParityEvents(sessionId);
        const metadataEvent = eventAt(events, 3);

        try {
            // When
            for (const event of events.slice(0, 3)) {
                await appendToAll(ledgers, event);
            }
            await appendEnvelopeWithStoreSequenceToAll(ledgers, {
                eventId: 'event_metadata_from_upstream',
                sequence: 99,
                createdAt: '2026-06-21T10:00:03.000Z',
                sessionId,
                durability: 'durable',
                event: metadataEvent,
            });
            for (const event of events.slice(4)) {
                await appendToAll(ledgers, event);
            }
            const replays = await Promise.all(ledgers.map((ledger) => ledger.getReplay(sessionId)));
            const jsonlReplay = replayAt(replays, 0);
            const plannedReplay = replayAt(replays, 1);

            // Then
            expect(replayParitySummary(plannedReplay)).toEqual(replayParitySummary(jsonlReplay));
            expect(jsonlReplay.envelopes.map((envelope) => envelope.sequence)).toEqual(
                events.map((_event, sequence) => sequence),
            );
            expect(jsonlReplay.snapshot).toMatchObject({
                status: 'stopped',
                completedTaskCount: 1,
                lastMessage: 'stopped parity session',
            });
            expect(jsonlReplay.sessionTree).toMatchObject({
                activeLeafId: 'entry_leaf',
                forkSource: { sessionId: 'session_parent', entryId: 'entry_parent_leaf' },
                cloneSource: { sessionId: 'session_template', entryId: 'entry_template_leaf' },
                compactionBoundaries: [
                    expect.objectContaining({
                        boundaryEntryId: 'entry_root',
                        firstKeptEntryId: 'entry_leaf',
                        boundarySequence: 1,
                        firstKeptSequence: 2,
                    }),
                ],
                imports: [expect.objectContaining({ sourceSessionId: 'session_import_source' })],
            });
        } finally {
            await closeAll(ledgers);
        }
    });

    it('rejects explicit envelope validation failures without advancing the next sequence', async () => {
        // Given
        const sessionId = 'session_replay_parity_validation';
        const ledgers = await openReplayParityLedgers(sessionId);
        const events = replayParityEvents(sessionId);
        const startedEvent = eventAt(events, 0);
        const rootEvent = eventAt(events, 1);

        try {
            await appendToAll(ledgers, startedEvent);

            // When
            for (const ledger of ledgers) {
                await expect(
                    ledger.appendEnvelope({
                        eventId: `event_bad_sequence_${ledger.label}`,
                        sequence: 7,
                        createdAt: '2026-06-21T10:00:07.000Z',
                        sessionId,
                        durability: 'durable',
                        event: rootEvent,
                    }),
                ).rejects.toMatchObject({ code: 'invalid_sequence', sessionId });
            }
            await appendToAll(ledgers, rootEvent);
            const replays = await Promise.all(ledgers.map((ledger) => ledger.getReplay(sessionId)));

            // Then
            for (const replay of replays) {
                expect(replay.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
                expect(replay.events.map((event) => event.message)).toEqual(['started parity session', 'root prompt']);
            }
        } finally {
            await closeAll(ledgers);
        }
    });

    it('fails closed when importing corrupt legacy JSONL while prefix replay reports the safe diagnostic', async () => {
        // Given
        const sessionId = 'session_replay_parity_corrupt';
        const ledgers = await openReplayParityLedgers(sessionId);
        const event = eventAt(replayParityEvents(sessionId), 0);
        const contents = [
            serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: '2026-06-21T10:00:00.000Z' })),
            serializeJsonlRecord(
                createJsonlSessionEventRecord({
                    eventId: 'event_0',
                    sequence: 0,
                    createdAt: '2026-06-21T10:00:00.000Z',
                    sessionId,
                    durability: 'durable',
                    event,
                }),
            ),
            '{"broken":\n',
        ].join('');

        try {
            // When
            const prefixReplay = projectJsonlSessionReplayPrefix({ sessionId, contents });
            for (const ledger of ledgers) {
                await expect(ledger.importLegacyJsonlStrict(contents)).rejects.toMatchObject({
                    code: 'corrupt_line',
                    lineNumber: 3,
                    sessionId,
                });
            }
            const replays = await Promise.all(ledgers.map((ledger) => ledger.getReplay(sessionId)));

            // Then
            expect(prefixReplay.projection.events).toEqual([event]);
            expect(prefixReplay.diagnostics).toEqual([{ code: 'corrupt_trailing_record', lineNumber: 3, sessionId }]);
            for (const replay of replays) {
                expect(replay.events).toEqual([]);
            }
        } finally {
            await closeAll(ledgers);
        }
    });

    it('projects empty sessions consistently before any durable events are appended', async () => {
        // Given
        const sessionId = 'session_replay_parity_empty';
        const ledgers = await openReplayParityLedgers(sessionId);

        try {
            // When
            const replays = await Promise.all(ledgers.map((ledger) => ledger.getReplay(sessionId)));
            const jsonlReplay = replayAt(replays, 0);
            const plannedReplay = replayAt(replays, 1);

            // Then
            expect(replayParitySummary(plannedReplay)).toEqual(replayParitySummary(jsonlReplay));
            expect(jsonlReplay.events).toEqual([]);
            expect(jsonlReplay.snapshot).toMatchObject({
                status: 'running',
                startedAt: '1970-01-01T00:00:00.000Z',
                completedTaskCount: 0,
            });
        } finally {
            await closeAll(ledgers);
        }
    });
});

async function openReplayParityLedgers(sessionId: string): Promise<readonly ReplayParityLedger[]> {
    const dataDir = await createTempDataDir();
    return [await openJsonlReplayParityLedger({ dataDir, sessionId }), new PlannedSqliteReplayLedgerFake(sessionId)];
}

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-replay-parity-'));
    tempDirs.push(dataDir);
    return dataDir;
}

async function appendToAll(ledgers: readonly ReplayParityLedger[], event: Parameters<ReplayParityLedger['append']>[0]) {
    for (const ledger of ledgers) {
        await ledger.append(event);
    }
}

async function appendEnvelopeWithStoreSequenceToAll(
    ledgers: readonly ReplayParityLedger[],
    envelope: Parameters<ReplayParityLedger['appendEnvelopeWithStoreSequence']>[0],
) {
    for (const ledger of ledgers) {
        await ledger.appendEnvelopeWithStoreSequence(envelope);
    }
}

async function closeAll(ledgers: readonly ReplayParityLedger[]): Promise<void> {
    await Promise.all(ledgers.map((ledger) => ledger.close()));
}

function eventAt(events: readonly AgentEvent[], index: number): AgentEvent {
    const event = events.at(index);
    if (event === undefined) {
        throw new Error(`Missing replay parity event at index ${index}`);
    }
    return event;
}

function replayAt(replays: readonly SessionReplayProjection[], index: number): SessionReplayProjection {
    const replay = replays.at(index);
    if (replay === undefined) {
        throw new Error(`Missing replay parity projection at index ${index}`);
    }
    return replay;
}
