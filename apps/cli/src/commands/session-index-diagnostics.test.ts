import {
    createFileSessionIndexStore,
    missionControlDataDirEnvKey,
    type SessionIndexDiagnostic,
    type SessionIndexSessionRecord,
} from '@mission-control/core';
import type { AgentEvent, AgentSnapshot } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import { writeSessionEvents } from './session-test-support.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session index diagnostics', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('surfaces sanitized index diagnostics only on their session', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const affectedSessionId = 'session_index_diagnostic_a';
        const cleanSessionId = 'session_index_diagnostic_b';
        await writeSessionEvents({
            dataDir,
            sessionId: affectedSessionId,
            events: [taskCompletedEvent(affectedSessionId)],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: cleanSessionId,
            events: [taskCompletedEvent(cleanSessionId)],
        });
        await writeIndexRecords({
            dataDir,
            records: [
                indexRecord(dataDir, affectedSessionId, 'stopped', 1, '2026-06-05T10:01:00.000Z'),
                indexRecord(dataDir, cleanSessionId, 'stopped', 1, '2026-06-05T10:01:00.000Z'),
            ],
            diagnostics: [indexDiagnostic(affectedSessionId)],
        });

        // When
        const lines = catalogLinesBySession(await runSessionCommand(parseArgs(['session', 'list'])));
        const showPayload = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', affectedSessionId])));

        // Then
        expect(lines.get(affectedSessionId)).toContain('diagnostics=1');
        expect(lines.get(cleanSessionId)).not.toContain('diagnostics=');
        expect(JSON.stringify(showPayload)).not.toContain('github_pat_SECRET');
        expect(showPayload.diagnostics).toEqual([
            {
                code: 'index_diagnostic',
                sessionId: affectedSessionId,
                message: 'session index contains a diagnostic record',
                lineNumber: 4,
            },
        ]);
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-index-diagnostics-'));
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function taskCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:01:00.000Z',
        sessionId,
        message: 'done',
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

function indexDiagnostic(sessionId: string): SessionIndexDiagnostic {
    return {
        kind: 'corrupt_jsonl',
        sessionId,
        filePath: join('sessions', `${sessionId}.jsonl`),
        code: 'unknown',
        message: 'github_pat_SECRET copied from a corrupt index',
        lineNumber: 4,
    };
}

async function writeIndexRecords(input: {
    readonly dataDir: string;
    readonly records: readonly SessionIndexSessionRecord[];
    readonly diagnostics: readonly SessionIndexDiagnostic[];
}): Promise<void> {
    await createFileSessionIndexStore({ indexPath: join(input.dataDir, 'session-index.json') }).replaceSessionIndex({
        sessionId: input.records[0]?.sessionId ?? 'session_index_test',
        records: input.records,
        diagnostics: input.diagnostics,
    });
}

function catalogLinesBySession(output: string): ReadonlyMap<string, string> {
    const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    return new Map(lines.map((line) => [line.split('\t')[0] ?? '', line]));
}
