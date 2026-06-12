import {
    createFileSessionIndexStore,
    missionControlDataDirEnvKey,
    type SessionIndexSessionRecord,
} from '@mission-control/core';
import type { AgentEvent, AgentSnapshot } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import { writeSessionEvents } from './session-test-support.js';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session index hardening', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('shows fresh index metadata without replacing JSONL facts', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_show_indexed';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'done')],
        });
        await writeIndexRecord(dataDir, indexRecord(dataDir, sessionId, 'stopped', 1, '2026-06-05T10:05:00.000Z'));

        // When
        const showPayload = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));

        // Then
        expect(showPayload).toMatchObject({
            sessionId,
            status: 'running',
            eventCount: 1,
            indexed: true,
            updatedAt: '2026-06-05T10:05:00.000Z',
        });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('does not let stale index metadata override JSONL catalog facts', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_stale_index';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskStartedEvent(sessionId), taskCompletedEvent(sessionId, 'done')],
        });
        await writeIndexRecord(dataDir, indexRecord(dataDir, sessionId, 'failed', 1, '2099-01-01T00:00:00.000Z'));

        // When
        const line = firstLine(await runSessionCommand(parseArgs(['session', 'list'])));

        // Then
        expect(line).toContain('status=running');
        expect(line).toContain('events=2');
        expect(line).toContain('index=jsonl');
        expect(line).toContain('updated=2026-06-05T10:01:00.000Z');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('does not trust index timestamps for header-only or missing JSONL sessions', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const headerOnlySessionId = 'session_header_only_index';
        const missingSessionId = 'session_missing_index_leftover';
        await writeSessionEvents({
            dataDir,
            sessionId: headerOnlySessionId,
            events: [],
        });
        await writeIndexRecords(dataDir, [
            indexRecord(dataDir, headerOnlySessionId, 'stopped', 0, '2099-01-01T00:00:00.000Z'),
            indexRecord(dataDir, missingSessionId, 'stopped', 0, '2099-01-01T00:01:00.000Z'),
        ]);

        // When
        const lines = catalogLinesBySession(await runSessionCommand(parseArgs(['session', 'list'])));

        // Then
        const headerOnlyLine = lines.get(headerOnlySessionId) ?? '';
        const missingLine = lines.get(missingSessionId) ?? '';
        expect(headerOnlyLine).toContain('status=running');
        expect(headerOnlyLine).toContain('events=0');
        expect(headerOnlyLine).toContain('index=jsonl');
        expect(headerOnlyLine).not.toContain('updated=');
        expect(missingLine).toContain('status=missing');
        expect(missingLine).toContain('events=0');
        expect(missingLine).toContain('index=jsonl');
        expect(missingLine).not.toContain('updated=');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('surfaces corrupt session indexes while preserving JSONL diagnostics', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const validSessionId = 'session_valid_index_corrupt';
        const corruptSessionId = 'session_log_and_index_corrupt';
        await writeSessionEvents({
            dataDir,
            sessionId: validSessionId,
            events: [taskCompletedEvent(validSessionId, 'valid')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: corruptSessionId,
            events: [taskCompletedEvent(corruptSessionId, 'corrupt')],
        });
        await appendFile(join(dataDir, 'sessions', `${corruptSessionId}.jsonl`), '{"broken":\n', 'utf8');
        await writeFile(join(dataDir, 'session-index.json'), '{"version":\n', 'utf8');

        // When
        const lines = catalogLinesBySession(await runSessionCommand(parseArgs(['session', 'list'])));

        // Then
        expect(lines.get(validSessionId)).toContain('index=corrupt');
        expect(lines.get(validSessionId)).toContain('diagnostics=1');
        expect(lines.get(corruptSessionId)).toContain('status=corrupt');
        expect(lines.get(corruptSessionId)).toContain('index=corrupt');
        expect(lines.get(corruptSessionId)).toContain('diagnostics=2');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('marks indexes missing required fields as corrupt', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_index_missing_diagnostics';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'done')],
        });
        await writeFile(
            join(dataDir, 'session-index.json'),
            `${JSON.stringify({ version: 1, records: [] })}\n`,
            'utf8',
        );

        // When
        const line = firstLine(await runSessionCommand(parseArgs(['session', 'list'])));

        // Then
        expect(line).toContain(sessionId);
        expect(line).toContain('index=corrupt');
        expect(line).toContain('diagnostics=1');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('classifies malformed lock metadata as corrupt even after it ages', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const badTimestampId = 'session_bad_lock_timestamp';
        const mismatchedId = 'session_bad_lock_owner';
        const malformedId = 'session_bad_lock_json';
        const readErrorId = 'session_bad_lock_read';
        for (const sessionId of [badTimestampId, mismatchedId, malformedId, readErrorId]) {
            await writeSessionEvents({
                dataDir,
                sessionId,
                events: [taskCompletedEvent(sessionId, 'done')],
            });
        }
        await writeLock(dataDir, badTimestampId, {
            sessionId: badTimestampId,
            createdAt: 'not-a-date',
        });
        await makeOld(join(dataDir, 'sessions', `${badTimestampId}.lock`));
        await writeLock(dataDir, mismatchedId, {
            sessionId: 'session_other',
            createdAt: '2026-06-05T10:00:00.000Z',
        });
        await makeOld(join(dataDir, 'sessions', `${mismatchedId}.lock`));
        await writeFile(join(dataDir, 'sessions', `${malformedId}.lock`), '{"sessionId":\n', 'utf8');
        await makeOld(join(dataDir, 'sessions', `${malformedId}.lock`));
        await mkdir(join(dataDir, 'sessions', `${readErrorId}.lock`));
        await makeOld(join(dataDir, 'sessions', `${readErrorId}.lock`));

        // When
        const lines = catalogLinesBySession(await runSessionCommand(parseArgs(['session', 'list'])));

        // Then
        expect(lines.get(badTimestampId)).toContain('lock=corrupt');
        expect(lines.get(mismatchedId)).toContain('lock=corrupt');
        expect(lines.get(malformedId)).toContain('lock=corrupt');
        expect(lines.get(readErrorId)).toContain('lock=corrupt');
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-index-'));
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function taskStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'task.started',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message: 'started',
    };
}

function taskCompletedEvent(sessionId: string, message: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:01:00.000Z',
        sessionId,
        message,
    };
}

function indexRecord(
    dataDir: string,
    sessionId: string,
    status: AgentSnapshot['status'],
    eventCount: number,
    updatedAt: string,
): SessionIndexSessionRecord {
    return {
        kind: 'session',
        sessionId,
        status,
        startedAt: '2026-06-05T10:00:00.000Z',
        eventCount,
        updatedAt,
        sourceFilePath: join(dataDir, 'sessions', `${sessionId}.jsonl`),
    };
}

async function writeIndexRecord(dataDir: string, record: SessionIndexSessionRecord): Promise<void> {
    await writeIndexRecords(dataDir, [record]);
}

async function writeIndexRecords(dataDir: string, records: readonly SessionIndexSessionRecord[]): Promise<void> {
    await createFileSessionIndexStore({ indexPath: join(dataDir, 'session-index.json') }).replaceSessionIndex({
        sessionId: records[0]?.sessionId ?? 'session_index_test',
        records,
        diagnostics: [],
    });
}

async function writeLock(
    dataDir: string,
    sessionId: string,
    metadata: Readonly<Record<'sessionId' | 'createdAt', string>>,
): Promise<void> {
    await writeFile(join(dataDir, 'sessions', `${sessionId}.lock`), `${JSON.stringify(metadata)}\n`, 'utf8');
}

async function makeOld(path: string): Promise<void> {
    const old = new Date('2026-06-05T09:00:00.000Z');
    await utimes(path, old, old);
}

function firstLine(output: string): string {
    return output.trim().split('\n')[0] ?? '';
}

function catalogLinesBySession(output: string): ReadonlyMap<string, string> {
    const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    return new Map(lines.map((line) => [line.split('\t')[0] ?? '', line]));
}
