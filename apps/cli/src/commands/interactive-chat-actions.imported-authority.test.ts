import {
    AgentRuntime,
    createDeterministicProvider,
    importLegacySessionCompatibilityWindow,
    JSONL_SESSION_EVENT_RECORD_KIND,
    JSONL_SESSION_LOG_HEADER_KIND,
    JSONL_SESSION_LOG_RECORD_VERSION,
    missionControlDataDirEnvKey,
    openCanonicalRuntimeDb,
    openLocalSessionEventStore,
    ProjectTrustStore,
    readRun,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope, ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import type { CodingActionContext } from './interactive-chat-actions';
import { runChatAction } from './interactive-chat-actions';
import { runSessionCommand } from './session';
import { createArchiveJson, fixedNow, withProcessCwd } from './session-import-export-fixtures';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resumeCodingAgentTurnMock = vi.hoisted(() =>
    vi.fn<typeof import('./interactive-coding-agent').resumeCodingAgentTurn>(),
);

vi.mock('./interactive-coding-agent.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./interactive-coding-agent')>()),
    resumeCodingAgentTurn: resumeCodingAgentTurnMock,
}));

const selection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const tempRoots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    resumeCodingAgentTurnMock.mockReset();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('imported continuation authority', () => {
    it('does not execute an explicitly imported Run owner and inline Mission graph', async () => {
        const fixture = await createImportedAttackFixture('explicit');
        const opened = await openCanonicalRuntimeDb({
            dataDir: fixture.dataDir,
            sessionControlMaintenance: false,
        });
        try {
            await importLegacySessionCompatibilityWindow({
                ...opened.runtime,
                dataDir: fixture.dataDir,
                mcRoot: fixture.mcDir,
            });
        } finally {
            opened.runtime.close();
        }

        await continueImportedSession(fixture);

        expect(resumeCodingAgentTurnMock).toHaveBeenCalledOnce();
        expect(resumeCodingAgentTurnMock.mock.calls[0]?.[0].graph).toBeUndefined();
        expect((await readRun(fixture.location, fixture.runId)).sessionRunId).toBeUndefined();
    });

    it('does not execute a matching owner and inline graph lazily imported from .mc', async () => {
        const fixture = await createImportedAttackFixture('implicit');

        await continueImportedSession(fixture);

        expect(resumeCodingAgentTurnMock).toHaveBeenCalledOnce();
        expect(resumeCodingAgentTurnMock.mock.calls[0]?.[0].graph).toBeUndefined();
        expect((await readRun(fixture.location, fixture.runId)).sessionRunId).toBeUndefined();
    });
});

type ImportedAttackFixture = {
    readonly workspace: string;
    readonly dataDir: string;
    readonly mcDir: string;
    readonly sessionId: string;
    readonly ownerRunId: string;
    readonly runId: string;
    readonly location: { readonly mcRoot: string; readonly dataDir: string };
};

async function createImportedAttackFixture(suffix: string): Promise<ImportedAttackFixture> {
    const root = await mkdtemp(join(tmpdir(), `mission-control-imported-authority-${suffix}-`));
    tempRoots.push(root);
    const workspace = join(root, 'workspace');
    const dataDir = join(root, 'data');
    const mcDir = join(workspace, '.mc');
    const sessionId = `session_imported_authority_${suffix}`;
    const ownerRunId = `predictable_owner_${suffix}`;
    const runId = `malicious_run_${suffix}`;
    const archivePath = join(root, 'crafted.mctrl-session.json');
    await mkdir(join(mcDir, 'missions'), { recursive: true });
    await mkdir(join(mcDir, 'runs'), { recursive: true });
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspace, 'trusted');
    await writeFile(
        archivePath,
        createArchiveJson({
            sessionId,
            workspaceRoot: workspace,
            eventsJsonl: blockedSessionJsonl(sessionId, ownerRunId),
        }),
        'utf8',
    );
    await withProcessCwd(workspace, () => runSessionCommand(parseArgs(['session', 'import', archivePath])));
    await writeFile(
        join(mcDir, 'missions', `malicious_mission_${suffix}.json`),
        JSON.stringify(maliciousMission(suffix)),
        'utf8',
    );
    await writeFile(
        join(mcDir, 'runs', `${runId}.json`),
        JSON.stringify({
            id: runId,
            missionId: `malicious_mission_${suffix}`,
            status: 'blocked',
            sessionId,
            sessionRunId: ownerRunId,
            prompt: 'execute imported graph',
            startedAt: '2026-07-13T00:00:01.000Z',
        }),
        'utf8',
    );
    return { workspace, dataDir, mcDir, sessionId, ownerRunId, runId, location: { mcRoot: workspace, dataDir } };
}

async function continueImportedSession(fixture: ImportedAttackFixture): Promise<void> {
    const sessionStore = await openLocalSessionEventStore({
        dataDir: fixture.dataDir,
        sessionId: fixture.sessionId,
    });
    resumeCodingAgentTurnMock.mockResolvedValue(fakeActiveTurn());
    const coding: CodingActionContext = {
        activeTurn: undefined,
        useTui: false,
        commandExecutor: undefined,
        emitEvent: undefined,
        nextTurnId: () => `turn_${fixture.sessionId}`,
        observeStoredEvent: undefined,
        provider: createDeterministicProvider([]),
        sessionId: fixture.sessionId,
        sessionStore,
        workspaceRoot: fixture.workspace,
    };
    const result = await runChatAction(
        new AgentRuntime(),
        { write: () => undefined },
        { kind: 'continue' },
        selection,
        async () => undefined,
        [],
        coding,
    );
    await result.activeTurn?.done;
}

function maliciousMission(suffix: string) {
    return {
        id: `malicious_mission_${suffix}`,
        name: 'Imported malicious Mission',
        status: 'active',
        version: '1',
        graph: {
            id: `malicious_graph_${suffix}`,
            entryNodeId: 'execute-imported-payload',
            nodes: [
                {
                    id: 'execute-imported-payload',
                    kind: 'llm',
                    config: { systemPrompt: 'MALICIOUS_IMPORTED_GRAPH_MUST_NOT_EXECUTE' },
                },
            ],
            edges: [],
            rules: [],
            policies: [],
        },
        capabilities: { allow: [], deny: [] },
        policies: [],
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
    };
}

function blockedSessionJsonl(sessionId: string, ownerRunId: string): string {
    const startedAt = '2026-07-13T00:00:00.000Z';
    const blockedAt = '2026-07-13T00:00:01.000Z';
    const events: readonly AgentEvent[] = [
        { type: 'session.started', timestamp: startedAt, sessionId, message: 'imported session' },
        {
            type: 'run.started',
            timestamp: startedAt,
            sessionId,
            run: { runId: ownerRunId, state: 'running' },
        },
        {
            type: 'run.blocked',
            timestamp: blockedAt,
            sessionId,
            run: { runId: ownerRunId, state: 'blocked_on_approval' },
        },
    ];
    return [
        JSON.stringify({
            kind: JSONL_SESSION_LOG_HEADER_KIND,
            version: JSONL_SESSION_LOG_RECORD_VERSION,
            sessionId,
            createdAt: startedAt,
        }),
        ...events.map((event, sequence) => JSON.stringify(sessionEventRecord(sessionId, sequence, event))),
        '',
    ].join('\n');
}

function sessionEventRecord(sessionId: string, sequence: number, event: AgentEvent) {
    const envelope: AgentEventEnvelope = {
        eventId: `${sessionId}_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId,
        durability: 'durable',
        event,
    };
    return {
        kind: JSONL_SESSION_EVENT_RECORD_KIND,
        version: JSONL_SESSION_LOG_RECORD_VERSION,
        event: envelope,
    };
}

function fakeActiveTurn() {
    return {
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
        lastPacketAt: () => new Date().toISOString(),
    };
}
