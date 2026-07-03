import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BOULDER_SCHEMA_VERSION, readBoulder, writeBoulder } from '../persistence/boulder-store.js';
import { projectSessionReplay } from '../session-replay.js';
import {
    CHECKPOINT_TOOL_NAME,
    CheckpointCoordinator,
    CheckpointCoordinatorError,
    createCheckpointToolRegistration,
    createRewindToolRegistration,
    REWIND_TOOL_NAME,
} from './checkpoint-tool.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
    tempRoots.push(root);
    return root;
}

function ctx(name: string): ToolExecutionContext {
    return { toolCallId: `tc_${name}`, toolName: name, signal: new AbortController().signal };
}

const FIXED_NOW = '2026-07-03T10:00:00.000Z';
const fixedClock = (): string => FIXED_NOW;

describe('CheckpointCoordinator — session-scoped state machine', () => {
    it('marks a checkpoint and exposes it via getCheckpoint', () => {
        const coord = new CheckpointCoordinator();
        expect(coord.getCheckpoint()).toBeNull();

        coord.markCheckpoint({
            goal: 'explore auth',
            startedAt: FIXED_NOW,
            messageCount: 4,
            entryId: 'entry_1',
        });

        expect(coord.getCheckpoint()).toMatchObject({ goal: 'explore auth', messageCount: 4 });
    });

    it('rejects a second checkpoint while one is active (checkpoint_active)', () => {
        const coord = new CheckpointCoordinator();
        coord.markCheckpoint({ goal: 'g', startedAt: FIXED_NOW, messageCount: 0, entryId: null });

        expect(() =>
            coord.markCheckpoint({ goal: 'g2', startedAt: FIXED_NOW, messageCount: 1, entryId: null }),
        ).toThrow(CheckpointCoordinatorError);
        expect(() =>
            coord.markCheckpoint({ goal: 'g2', startedAt: FIXED_NOW, messageCount: 1, entryId: null }),
        ).toThrow(expect.objectContaining({ code: 'checkpoint_active' }));
        // The first checkpoint survives the rejected second mark.
        expect(coord.getCheckpoint()?.goal).toBe('g');
    });

    it('collapses an active checkpoint into a rewind record and clears the marker', () => {
        const coord = new CheckpointCoordinator();
        coord.markCheckpoint({ goal: 'probe db', startedAt: FIXED_NOW, messageCount: 7, entryId: 'e9' });

        const record = coord.recordRewind('found the leak in pool.ts', '2026-07-03T10:05:00.000Z');

        expect(record).toMatchObject({
            report: 'found the leak in pool.ts',
            collapsedMessageCount: 7,
            checkpointStartedAt: FIXED_NOW,
            goal: 'probe db',
        });
        expect(coord.getCheckpoint()).toBeNull();
        expect(coord.getRewind()).toBe(record);
    });

    it('rejects rewind when no checkpoint is active (checkpoint_missing)', () => {
        const coord = new CheckpointCoordinator();
        expect(() => coord.recordRewind('report', FIXED_NOW)).toThrow(CheckpointCoordinatorError);
        expect(() => coord.recordRewind('report', FIXED_NOW)).toThrow(
            expect.objectContaining({ code: 'checkpoint_missing' }),
        );
    });

    it('supports a fresh checkpoint->rewind cycle after the first collapses', () => {
        const coord = new CheckpointCoordinator();
        coord.markCheckpoint({ goal: 'first', startedAt: FIXED_NOW, messageCount: 2, entryId: null });
        coord.recordRewind('first report', FIXED_NOW);

        // Second cycle is independent of the first.
        coord.markCheckpoint({ goal: 'second', startedAt: FIXED_NOW, messageCount: 9, entryId: 'e2' });
        const second = coord.recordRewind('second report', FIXED_NOW);
        expect(second.goal).toBe('second');
        expect(second.collapsedMessageCount).toBe(9);
    });

    it('clear() resets both checkpoint and rewind', () => {
        const coord = new CheckpointCoordinator();
        coord.markCheckpoint({ goal: 'g', startedAt: FIXED_NOW, messageCount: 1, entryId: null });
        coord.recordRewind('r', FIXED_NOW);

        coord.clear();

        expect(coord.getCheckpoint()).toBeNull();
        expect(coord.getRewind()).toBeNull();
    });
});

describe('checkpoint tool — marks state via the coordinator', () => {
    it('marks a checkpoint and returns the captured snapshot', async () => {
        const coord = new CheckpointCoordinator();
        const tool = createCheckpointToolRegistration({
            coordinator: coord,
            resolveSnapshot: () => ({ messageCount: 5, entryId: 'entry_a' }),
            now: fixedClock,
        });

        const out = await tool.execute({ goal: 'investigate the flaky test' }, ctx(CHECKPOINT_TOOL_NAME));

        expect(out).toMatchObject({
            goal: 'investigate the flaky test',
            startedAt: FIXED_NOW,
            messageCount: 5,
            entryId: 'entry_a',
        });
        expect(coord.getCheckpoint()?.goal).toBe('investigate the flaky test');
        expect(coord.getCheckpoint()?.messageCount).toBe(5);
    });

    it('defaults the snapshot to an empty buffer when no resolver is wired', async () => {
        const coord = new CheckpointCoordinator();
        const tool = createCheckpointToolRegistration({ coordinator: coord, now: fixedClock });

        const out = await tool.execute({ goal: 'bare host' }, ctx(CHECKPOINT_TOOL_NAME));

        expect(out.messageCount).toBe(0);
        expect(out.entryId).toBeNull();
    });

    it('rejects a second checkpoint while one is active', async () => {
        const coord = new CheckpointCoordinator();
        const tool = createCheckpointToolRegistration({ coordinator: coord, now: fixedClock });
        await tool.execute({ goal: 'first' }, ctx(CHECKPOINT_TOOL_NAME));

        await expect(tool.execute({ goal: 'second' }, ctx(CHECKPOINT_TOOL_NAME))).rejects.toMatchObject({
            error: expect.objectContaining({ code: 'tool_failed' }),
        });
        // The active checkpoint is untouched.
        expect(coord.getCheckpoint()?.goal).toBe('first');
    });
});

describe('checkpoint tool — schema validation', () => {
    it('rejects an empty goal before execute runs', () => {
        const coord = new CheckpointCoordinator();
        const tool = createCheckpointToolRegistration({ coordinator: coord });
        const parsed = tool.inputSchema.safeParse({ goal: '' });
        expect(parsed.success).toBe(false);
    });

    it('rejects an unknown key (strict schema)', () => {
        const tool = createCheckpointToolRegistration({ coordinator: new CheckpointCoordinator() });
        const parsed = tool.inputSchema.safeParse({ goal: 'g', extra: true });
        expect(parsed.success).toBe(false);
    });
});

describe('rewind tool — collapses to a report', () => {
    it('requires an active checkpoint and throws otherwise', async () => {
        const coord = new CheckpointCoordinator();
        const tool = createRewindToolRegistration({ coordinator: coord, now: fixedClock });

        await expect(tool.execute({ report: 'r' }, ctx(REWIND_TOOL_NAME))).rejects.toMatchObject({
            error: expect.objectContaining({ code: 'tool_failed' }),
        });
    });

    it('collapses the checkpoint into a report, consumes the marker, and records the window', async () => {
        const coord = new CheckpointCoordinator();
        const checkpoint = createCheckpointToolRegistration({
            coordinator: coord,
            resolveSnapshot: () => ({ messageCount: 6, entryId: 'e1' }),
            now: fixedClock,
        });
        const rewind = createRewindToolRegistration({ coordinator: coord, now: () => '2026-07-03T10:09:00.000Z' });
        await checkpoint.execute({ goal: 'trace the deadlock' }, ctx(CHECKPOINT_TOOL_NAME));

        const out = await rewind.execute({ report: 'the lock is held in session.ts:42' }, ctx(REWIND_TOOL_NAME));

        expect(out).toMatchObject({
            report: 'the lock is held in session.ts:42',
            rewound: true,
            rewoundAt: '2026-07-03T10:09:00.000Z',
            collapsedMessageCount: 6,
        });
        // The checkpoint is consumed; the rewind record survives for the session layer.
        expect(coord.getCheckpoint()).toBeNull();
        expect(coord.getRewind()?.report).toBe('the lock is held in session.ts:42');
    });

    it('rejects an empty report before execute runs', () => {
        const tool = createRewindToolRegistration({ coordinator: new CheckpointCoordinator() });
        expect(tool.inputSchema.safeParse({ report: '' }).success).toBe(false);
    });

    it('rejects an unknown key (strict schema)', () => {
        const tool = createRewindToolRegistration({ coordinator: new CheckpointCoordinator() });
        expect(tool.inputSchema.safeParse({ report: 'r', extra: true }).success).toBe(false);
    });
});

describe('checkpoint / rewind — model output formatting', () => {
    it('formats a checkpoint result with goal and message count', () => {
        const tool = createCheckpointToolRegistration({ coordinator: new CheckpointCoordinator() });
        const out = tool.toModelOutput?.({
            goal: 'map the call graph',
            startedAt: FIXED_NOW,
            messageCount: 3,
            entryId: null,
        });
        expect(out).toContain('map the call graph');
        expect(out).toContain('3');
        expect(out).toContain('rewind');
    });

    it('formats a rewind result with the collapsed window and report', () => {
        const tool = createRewindToolRegistration({ coordinator: new CheckpointCoordinator() });
        const out = tool.toModelOutput?.({
            report: 'root cause was a stale cache',
            rewound: true,
            rewoundAt: FIXED_NOW,
            collapsedMessageCount: 11,
        });
        expect(out).toContain('11');
        expect(out).toContain('root cause was a stale cache');
    });
});

describe('checkpoint / rewind — replay projections stay valid', () => {
    it('does not mutate replay inputs across a checkpoint->rewind cycle', () => {
        const sessionId = 'session_checkpoint_replay';
        const events: readonly AgentEvent[] = [
            graphEvent('graph.started', sessionId),
            nodeEvent('node.started', sessionId, 'node_llm'),
            nodeEvent('node.completed', sessionId, 'node_llm'),
            graphEvent('graph.completed', sessionId),
        ];
        const envelopes: readonly AgentEventEnvelope[] = events.map((event, sequence) =>
            envelope(event, sequence, sessionId),
        );

        const before = projectSessionReplay({ sessionId, envelopes });

        // Run a full checkpoint -> rewind cycle on a coordinator. The tools hold
        // no handle to the envelopes, so the projection must be byte-identical.
        const coord = new CheckpointCoordinator();
        coord.markCheckpoint({ goal: 'g', startedAt: FIXED_NOW, messageCount: events.length, entryId: null });
        coord.recordRewind('collapsed report', FIXED_NOW);

        const after = projectSessionReplay({ sessionId, envelopes });

        expect(after.events).toEqual(before.events);
        expect(after.timeline).toEqual(before.timeline);
        expect(after.graphSnapshots).toEqual(before.graphSnapshots);
        expect(after.codingSteps).toEqual(before.codingSteps);
        expect(after.diagnostics).toEqual(before.diagnostics);
    });
});

describe('checkpoint / rewind — boulder passthrough round-trip (readBoulder/writeBoulder direct)', () => {
    it('preserves a checkpoint report and unrelated orchestrator fields across a round-trip', async () => {
        const root = makeTempRoot();
        mkdirSync(join(root, '.omo'), { recursive: true });

        const raw = {
            schema_version: BOULDER_SCHEMA_VERSION,
            active_work_id: 'work_c',
            works: {
                work_c: {
                    work_id: 'work_c',
                    active_plan: '/tmp/plan.md',
                    plan_name: 'plan',
                    status: 'active',
                    started_at: FIXED_NOW,
                    updated_at: FIXED_NOW,
                    session_ids: ['sess_1'],
                    session_origins: {},
                    continuation_runtime: { iteration: 2, loopActive: true },
                },
            },
            top_level_orchestrator_field: 'keep-me',
        };
        writeFileSync(join(root, '.omo', 'boulder.json'), `${JSON.stringify(raw)}\n`);

        const boulder = await readBoulder(root);
        expect(boulder).not.toBeNull();
        if (boulder === null) throw new Error('seed boulder missing');
        const before = boulder.works['work_c'];
        if (before === undefined) throw new Error('seed work missing');
        const updatedWork = { ...before, checkpoint_rewind: { report: 'collapsed findings', rewoundAt: FIXED_NOW } };
        await writeBoulder(root, { ...boulder, works: { ...boulder.works, work_c: updatedWork } });

        const reread = await readBoulder(root);
        expect(reread).not.toBeNull();
        if (reread === null) throw new Error('reread missing');
        const work = reread.works['work_c'];
        expect(work?.['checkpoint_rewind']).toMatchObject({ report: 'collapsed findings', rewoundAt: FIXED_NOW });
        expect(work?.['continuation_runtime']).toEqual({ iteration: 2, loopActive: true });
        expect(reread['top_level_orchestrator_field']).toBe('keep-me');
    });
});

// --------------------------- replay envelope helpers ---------------------------

type EnvelopeOptions = { readonly eventId?: string };

function envelope(
    event: AgentEvent,
    sequence: number,
    sessionId: string,
    options: EnvelopeOptions = {},
): AgentEventEnvelope {
    return {
        eventId: options.eventId ?? `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId,
        durability: 'durable',
        event,
    };
}

function graphEvent(type: 'graph.started' | 'graph.completed', sessionId: string): AgentEvent {
    return {
        type,
        timestamp: type === 'graph.started' ? '2026-07-03T10:00:00.000Z' : '2026-07-03T10:00:03.000Z',
        sessionId,
        message: type,
        abg: { graphId: 'graph_checkpoint_replay' },
    };
}

function nodeEvent(type: 'node.started' | 'node.completed', sessionId: string, nodeId: string): AgentEvent {
    return {
        type,
        timestamp: type === 'node.started' ? '2026-07-03T10:00:01.000Z' : '2026-07-03T10:00:02.000Z',
        sessionId,
        message: type,
        abg: {
            graphId: 'graph_checkpoint_replay',
            nodeId,
            signalType: type === 'node.started' ? 'started' : 'success',
            ...(type === 'node.completed' ? { model: { providerID: 'local', modelID: 'local-echo' } } : {}),
        },
    };
}
