import type { AgentEvent, ModelProviderSelection, ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import type { ProviderAdapter, ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { ProjectTrustStore } from '../trust/project-trust-store.js';
import { deferred, messageContents, providerFromRequests } from './run-coordinator-test-support.js';
import { SessionRunOwnerRegistry } from './run-owner.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'deterministic' };

afterEach(async () => {
    for (const dataDir of tempDirs.splice(0)) {
        await rm(dataDir, { recursive: true, force: true });
    }
});

describe('SessionRunOwnerRegistry', () => {
    it('serializes submit, resume, and interrupt through one active owner', async () => {
        // Given
        const dataDir = await makeDataDir('mission-control-run-owner-active-');
        const sessionId = 'session_owner_active';
        const started = deferred<void>();
        const cleanupFinished = deferred<void>();
        const requests: ProviderTurnRequest[] = [];
        let iteratorClosed = false;
        let providerSignal: AbortSignal | undefined;
        const registry = createRegistry(
            dataDir,
            abortableProvider({
                requests,
                started,
                cleanupFinished,
                markClosed: () => {
                    iteratorClosed = true;
                },
                captureSignal: (signal) => {
                    providerSignal = signal;
                },
            }),
        );

        // When
        const submitted = registry.submit({
            sessionId,
            inputId: 'input_submit',
            messageId: 'message_submit',
            prompt: 'run until interrupted',
        });
        await started.promise;
        const running = await registry.status({ sessionId });
        const resumed = registry.resume({ sessionId });
        const interrupted = registry.interrupt({ sessionId, reason: 'operator interrupt' });
        await Promise.resolve();
        cleanupFinished.resolve();
        const [submitReceipt, resumeReceipt, interruptReceipt] = await Promise.all([submitted, resumed, interrupted]);
        const events = await readEvents(dataDir, sessionId);

        // Then
        expect(running).toMatchObject({ sessionId, status: 'running', runId: 'run_1' });
        expect(submitReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(resumeReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(interruptReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(iteratorClosed).toBe(true);
        expect(providerSignal?.aborted).toBe(true);
        expect(requests).toHaveLength(1);
        expect(countEvents(events, 'run.started')).toBe(1);
        expect(commands(events)).toEqual(expect.arrayContaining(['steer', 'run', 'resume', 'interrupt']));
    });

    it('keeps trusted project context on the active run while resume and interrupt attach', async () => {
        // Given
        const dataDir = await makeDataDir('mission-control-run-owner-context-');
        const workspaceRoot = await makeDataDir('mission-control-run-owner-workspace-');
        const trustStore = new ProjectTrustStore({ dataDir, now: fixedNow });
        await writeFile(join(workspaceRoot, 'AGENTS.md'), 'TRUSTED_OWNER_CONTEXT', 'utf8');
        await trustStore.setDecision(workspaceRoot, 'trusted');
        const sessionId = 'session_owner_context_interrupt';
        const started = deferred<void>();
        const cleanupFinished = deferred<void>();
        const requests: ProviderTurnRequest[] = [];
        const registry = createRegistry(
            dataDir,
            abortableProvider({
                requests,
                started,
                cleanupFinished,
                markClosed: () => undefined,
                captureSignal: () => undefined,
            }),
            { workspaceRoot, trustStore },
        );

        // When
        const submitted = registry.submit({
            sessionId,
            inputId: 'input_context',
            messageId: 'message_context',
            prompt: 'run context until interrupted',
        });
        await started.promise;
        const resumed = registry.resume({ sessionId });
        const interrupted = registry.interrupt({ sessionId, reason: 'operator interrupt' });
        cleanupFinished.resolve();
        const [submitReceipt, resumeReceipt, interruptReceipt] = await Promise.all([submitted, resumed, interrupted]);

        // Then
        expect(submitReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(resumeReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(interruptReceipt).toMatchObject({ sessionId, status: 'interrupted', runId: 'run_1' });
        expect(requests).toHaveLength(1);
        expect(requests[0] === undefined ? [] : messageContents(requests[0].messages)).toEqual([
            expect.stringContaining('TRUSTED_OWNER_CONTEXT'),
            'run context until interrupted',
        ]);
    });

    it('returns the same active run state to a second attach instead of creating a duplicate owner', async () => {
        // Given
        const dataDir = await makeDataDir('mission-control-run-owner-duplicate-');
        const sessionId = 'session_owner_duplicate';
        const started = deferred<void>();
        const release = deferred<void>();
        const mutableRequests: string[][] = [];
        const registry = createRegistry(
            dataDir,
            providerFromRequests((request) => {
                mutableRequests.push([...messageContents(request.messages)]);
                started.resolve();
                return release.promise;
            }),
        );

        // When
        const submitted = registry.submit({
            sessionId,
            inputId: 'input_duplicate',
            messageId: 'message_duplicate',
            prompt: 'single provider turn',
        });
        await started.promise;
        const running = await registry.status({ sessionId });
        const resumed = registry.resume({ sessionId });
        release.resolve();
        const [submitReceipt, resumeReceipt] = await Promise.all([submitted, resumed]);
        const events = await readEvents(dataDir, sessionId);

        // Then
        expect(running).toMatchObject({ sessionId, status: 'running', runId: 'run_1' });
        expect(submitReceipt).toMatchObject({ sessionId, status: 'completed', runId: 'run_1' });
        expect(resumeReceipt).toMatchObject({ sessionId, status: 'completed', runId: 'run_1' });
        expect(mutableRequests).toEqual([['single provider turn']]);
        expect(countEvents(events, 'run.started')).toBe(1);
        expect(commands(events)).toEqual(expect.arrayContaining(['run', 'resume']));
    });

    it('resumes durable queued input after the owner registry is recreated', async () => {
        // Given
        const dataDir = await makeDataDir('mission-control-run-owner-restart-');
        const sessionId = 'session_owner_restart';
        const firstProcess = createRegistry(
            dataDir,
            providerFromRequests(() => {
                throw new TypeError('queued input should not call the provider before resume');
            }),
        );
        const queued = await firstProcess.queue({
            sessionId,
            inputId: 'input_restart',
            messageId: 'message_restart',
            prompt: 'resume queued work after restart',
        });
        const resumedRequests: string[][] = [];
        const restartedProcess = createRegistry(
            dataDir,
            providerFromRequests((request) => {
                resumedRequests.push([...messageContents(request.messages)]);
                return Promise.resolve();
            }),
        );

        // When
        const resumed = await restartedProcess.resume({ sessionId });
        const events = await readEvents(dataDir, sessionId);

        // Then
        expect(queued).toMatchObject({ sessionId, status: 'queued' });
        expect(resumed).toMatchObject({ sessionId, status: 'completed' });
        expect(resumedRequests).toEqual([['resume queued work after restart']]);
        expect(countEvents(events, 'prompt.promoted')).toBe(1);
        expect(countEvents(events, 'run.completed')).toBe(1);
    });
});

function createRegistry(
    dataDir: string,
    provider: ProviderAdapter,
    projectContext?: { readonly workspaceRoot: string; readonly trustStore: ProjectTrustStore },
): SessionRunOwnerRegistry {
    return new SessionRunOwnerRegistry({
        dataDir,
        provider,
        modelProviderSelection,
        now: fixedNow,
        timeoutMs: 50,
        createEventId: (_event, sequence) => `event_${sequence}`,
        createId: (prefix, index) => `${prefix}_${index}`,
        ...(projectContext !== undefined ? { projectContext } : {}),
    });
}

function abortableProvider(input: {
    readonly requests: ProviderTurnRequest[];
    readonly started: ReturnType<typeof deferred<void>>;
    readonly cleanupFinished: ReturnType<typeof deferred<void>>;
    readonly markClosed: () => void;
    readonly captureSignal: (signal: AbortSignal) => void;
}): ProviderAdapter {
    return {
        streamTurn(request, context) {
            input.requests.push(request);
            input.captureSignal(context.signal);
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next() {
                            input.started.resolve();
                            return new Promise<IteratorResult<ProviderStreamChunk>>(() => undefined);
                        },
                        async return() {
                            input.markClosed();
                            await input.cleanupFinished.promise;
                            return { done: true, value: undefined };
                        },
                    };
                },
            };
        },
    };
}

async function makeDataDir(prefix: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dataDir);
    return dataDir;
}

async function readEvents(dataDir: string, sessionId: string): Promise<readonly AgentEvent[]> {
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: fixedNow,
        createEventId: (_event, sequence) => `read_event_${sequence}`,
    });
    try {
        return await store.getEvents(sessionId);
    } finally {
        await store.close();
    }
}

function countEvents(events: readonly AgentEvent[], type: AgentEvent['type']): number {
    return events.filter((event) => event.type === type).length;
}

function commands(events: readonly AgentEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === 'run.command.received' && event.run?.command !== undefined ? [event.run.command] : [],
    );
}

function fixedNow(): string {
    return '2026-06-09T00:00:00.000Z';
}
