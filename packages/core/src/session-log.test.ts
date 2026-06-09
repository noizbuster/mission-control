import type { AgentSession } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectAbgSignalToEvent } from './behavior/signals.js';
import { SessionEventLog } from './session-log.js';

describe('SessionEventLog', () => {
    it('keeps events append-only and derives snapshots from the log', () => {
        const session: AgentSession = {
            id: 'session_test',
            status: 'stopped',
            startedAt: '2026-06-02T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'session.started',
            timestamp: session.startedAt,
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'task.started',
            timestamp: '2026-06-02T10:00:01.000Z',
            sessionId: session.id,
            taskId: 'task_1',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:02.000Z',
            sessionId: session.id,
            taskId: 'task_1',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'session.stopped',
            timestamp: '2026-06-02T10:00:03.000Z',
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
        });

        const externalEvents = log.getEvents();
        externalEvents.pop();

        expect(log.getEvents()).toHaveLength(4);
        expect(log.getSnapshot(session)).toMatchObject({
            sessionId: session.id,
            status: 'stopped',
            startedAt: session.startedAt,
            stoppedAt: '2026-06-02T10:00:03.000Z',
            runningTaskCount: 0,
            completedTaskCount: 1,
            failedTaskCount: 0,
            lastMessage: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });
    });

    it('derives provider model selection from the latest event in snapshots', () => {
        const session: AgentSession = {
            id: 'session_test',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'session.started',
            timestamp: session.startedAt,
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        log.append({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:01.000Z',
            sessionId: session.id,
            taskId: 'task_1',
            message: 'done',
            nativeSidecarStatus: 'mock',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });

        expect(log.getSnapshot(session).modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('keeps existing task snapshot counts before ABG graph state projection', () => {
        const session: AgentSession = {
            id: 'session_baseline',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'task.started',
            timestamp: '2026-06-02T10:00:01.000Z',
            sessionId: session.id,
            taskId: 'task_running',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'task.failed',
            timestamp: '2026-06-02T10:00:02.000Z',
            sessionId: session.id,
            taskId: 'task_failed',
            nativeSidecarStatus: 'mock',
        });

        expect(log.getSnapshot(session)).toMatchObject({
            runningTaskCount: 1,
            completedTaskCount: 0,
            failedTaskCount: 1,
        });
    });

    it('timeline explains ABG execution and reconstructs graph state', () => {
        const session: AgentSession = {
            id: 'session_abg',
            status: 'running',
            startedAt: '2026-06-03T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'graph.started',
            timestamp: session.startedAt,
            sessionId: session.id,
            message: 'graph started: research-answer',
            nativeSidecarStatus: 'mock',
            abg: {
                graphId: 'research-answer',
                correlationId: 'run_1',
            },
        });
        log.append(
            projectAbgSignalToEvent({
                graphId: 'research-answer',
                sessionId: session.id,
                timestamp: '2026-06-03T10:00:01.000Z',
                signal: {
                    type: 'started',
                    nodeId: 'node_search',
                },
            }),
        );
        log.append(
            projectAbgSignalToEvent({
                graphId: 'research-answer',
                sessionId: session.id,
                timestamp: '2026-06-03T10:00:01.500Z',
                signal: {
                    type: 'select',
                    nodeId: 'node_search',
                    target: 'node_answer',
                    reason: 'rule matched: search-succeeded',
                },
            }),
        );
        log.append(
            projectAbgSignalToEvent({
                graphId: 'research-answer',
                sessionId: session.id,
                timestamp: '2026-06-03T10:00:02.000Z',
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                },
                signal: {
                    type: 'success',
                    nodeId: 'node_search',
                    result: {
                        documents: 3,
                    },
                },
            }),
        );
        log.append({
            type: 'graph.completed',
            timestamp: '2026-06-03T10:00:03.000Z',
            sessionId: session.id,
            message: 'graph completed: research-answer',
            nativeSidecarStatus: 'mock',
            abg: {
                graphId: 'research-answer',
                correlationId: 'run_1',
            },
        });

        expect(log.getGraphSnapshot('research-answer')).toMatchObject({
            graphId: 'research-answer',
            status: 'completed',
            activeNodeIds: [],
            nodes: [
                {
                    nodeId: 'node_search',
                    status: 'succeeded',
                    lastSignalType: 'success',
                },
            ],
        });
        expect(log.getTimeline().map((entry) => entry.type)).toEqual([
            'graph.started',
            'node.started',
            'decision.selected',
            'node.completed',
            'graph.completed',
        ]);
        expect(log.getTimeline().find((entry) => entry.type === 'node.completed')?.model).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'default',
        });
    });

    it('empty ABG timeline returns an empty array', () => {
        const log = new SessionEventLog();

        expect(log.getTimeline()).toEqual([]);
    });

    it('keeps task snapshots compatible when ABG graph events are present', () => {
        const session: AgentSession = {
            id: 'session_mixed',
            status: 'running',
            startedAt: '2026-06-03T10:00:00.000Z',
        };
        const log = new SessionEventLog();

        log.append({
            type: 'task.started',
            timestamp: '2026-06-03T10:00:01.000Z',
            sessionId: session.id,
            taskId: 'task_existing',
            nativeSidecarStatus: 'mock',
        });
        log.append({
            type: 'node.completed',
            timestamp: '2026-06-03T10:00:02.000Z',
            sessionId: session.id,
            nativeSidecarStatus: 'mock',
            abg: {
                graphId: 'graph_existing',
                nodeId: 'node_existing',
                signalType: 'success',
            },
        });

        expect(log.getSnapshot(session)).toMatchObject({
            runningTaskCount: 1,
            completedTaskCount: 0,
            failedTaskCount: 0,
        });
    });
});
