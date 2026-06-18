import type { AgentEvent, ProtocolError, ProviderStreamChunk } from '@mission-control/protocol';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import type { ProviderAdapter, ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { type RunCoordinatorStore, SessionRunCoordinator } from './run-coordinator.js';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle.js';
import type { RunCoordinatorTurnRunner } from './run-coordinator-types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export type CoordinatorContext = {
    readonly sessionId: string;
    readonly dataDir: string;
    readonly store: JsonlSessionEventStore;
    readonly createCoordinator: (provider: ProviderAdapter) => SessionRunCoordinator;
    readonly events: () => Promise<readonly AgentEvent[]>;
};

export async function cleanupCoordinatorContexts(): Promise<void> {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export async function openCoordinatorContext(sessionId: string): Promise<CoordinatorContext> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-run-coordinator-'));
    tempDirs.push(dataDir);
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: fixedNow,
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
    return {
        sessionId,
        dataDir,
        store,
        createCoordinator: (provider) =>
            new SessionRunCoordinator({
                sessionId,
                store,
                provider,
                modelProviderSelection: { providerID: 'local', modelID: 'deterministic' },
                now: fixedNow,
                runProviderTurn: createTestTurnRunner(provider),
                createId: (prefix, index) => `${prefix}_${index}`,
            }),
        events: () => store.getEvents(sessionId),
    };
}

export function providerFromRequests(
    onRequest: (request: ProviderTurnRequest, index: number) => Promise<void>,
): ProviderAdapter {
    let index = 0;
    return {
        async *streamTurn(request, context) {
            await onRequest(request, index);
            index += 1;
            if (context.signal.aborted) {
                throw new Error('provider turn aborted');
            }
        },
    };
}

function createTestTurnRunner(provider: ProviderAdapter): RunCoordinatorTurnRunner {
    return async (context) => {
        const messages = await context.readMessages();
        const request: ProviderTurnRequest = {
            requestId: `test_req_${Date.now()}`,
            sessionId: 'test',
            turnId: `test_turn_${Date.now()}`,
            providerID: 'local',
            modelID: 'deterministic',
            messages,
        };
        let failure: ProtocolError | undefined;
        for await (const chunk of provider.streamTurn(request, { attempt: 1, signal: context.signal })) {
            if (chunk.kind === 'response_completed') {
                await context.appendDurableEvent({
                    type: 'model.call.completed',
                    timestamp: fixedNow(),
                    sessionId: 'test',
                    message: chunk.message.content,
                    durability: 'durable',
                    providerStreamChunk: chunk,
                });
            }
            if (chunk.kind === 'response_failed') {
                failure = chunk.error;
            }
        }
        if (context.signal.aborted) {
            return { status: 'interrupted' };
        }
        if (failure !== undefined) {
            return { status: 'failed', reason: failure.message, errorCode: failure.code };
        }
        return { status: 'completed' };
    };
}

function fixedNow(): string {
    return '2026-06-09T10:00:00.000Z';
}
