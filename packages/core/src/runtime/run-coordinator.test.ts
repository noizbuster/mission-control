import type { ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { projectSessionAdmission } from '../session-admission.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
    cleanupCoordinatorContexts,
    deferred,
    messageContents,
    openCoordinatorContext,
    providerFromRequests,
    reopenCoordinatorContext,
} from './run-coordinator-test-support.js';

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

describe('SessionRunCoordinator', () => {
    it('queues follow-up input while a provider turn is running and promotes it after settlement', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_queue');
        const firstStarted = deferred<void>();
        const releaseFirst = deferred<void>();
        const requests: string[][] = [];
        const coordinator = context.createCoordinator(
            providerFromRequests((request, index) => {
                requests.push([...messageContents(request.messages)]);
                if (index === 0) {
                    firstStarted.resolve();
                    return releaseFirst.promise;
                }
                return Promise.resolve();
            }),
        );
        await coordinator.steer({ inputId: 'input_first', messageId: 'message_first', prompt: 'first' });

        // When
        const wake = coordinator.wake();
        await firstStarted.promise;
        await coordinator.queue({ inputId: 'input_second', messageId: 'message_second', prompt: 'second' });
        const duringRun = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        releaseFirst.resolve();
        await wake;
        const afterRun = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const events = await context.events();

        // Then
        expect(duringRun.modelVisibleMessages.map((message) => message.content)).toEqual(['first']);
        expect(duringRun.pendingInputs.map((input) => input.inputId)).toEqual(['input_second']);
        expect(afterRun.modelVisibleMessages.map((message) => message.content)).toEqual(['first', 'second']);
        expect(requests).toEqual([['first'], ['first', 'second']]);
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['run.command.received', 'run.started', 'run.completed']),
        );
        await context.store.close();
    });

    it('resumes durable queued input after restart', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_resume');
        const provider = providerFromRequests(() => Promise.resolve());
        await context.createCoordinator(provider).queue({
            inputId: 'input_resume',
            messageId: 'message_resume',
            prompt: 'resume me',
            resume: false,
        });
        await context.store.close();
        const restarted = await reopenCoordinatorContext(context);
        const requests: string[][] = [];

        // When
        await restarted
            .createCoordinator(
                providerFromRequests((request) => {
                    requests.push([...messageContents(request.messages)]);
                    return Promise.resolve();
                }),
            )
            .resume();

        // Then
        expect(requests).toEqual([['resume me']]);
        expect(
            projectSessionAdmission(await restarted.store.getEvents(restarted.sessionId), restarted.sessionId)
                .pendingInputs,
        ).toEqual([]);
        await restarted.store.close();
    });

    it('continues generated prompt ids after reopening a durable session', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_generated_id_resume');
        const provider = providerFromRequests(() => Promise.resolve());
        await context.createCoordinator(provider).queue({ prompt: 'first generated' });
        await context.createCoordinator(provider).resume();
        await context.store.close();
        const restarted = await reopenCoordinatorContext(context);

        // When
        await restarted.createCoordinator(provider).queue({ prompt: 'second generated' });
        await restarted.createCoordinator(provider).resume();
        const projection = projectSessionAdmission(
            await restarted.store.getEvents(restarted.sessionId),
            restarted.sessionId,
        );
        const generatedInputs = projection.admittedInputs.filter((input) => input.prompt.endsWith('generated'));

        // Then
        expect(generatedInputs.map((input) => input.prompt)).toEqual(['first generated', 'second generated']);
        expect(new Set(generatedInputs.map((input) => input.inputId)).size).toBe(2);
        await restarted.store.close();
    });

    it('runs an explicit provider attempt even when no input is eligible', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_explicit');
        const requests: string[][] = [];

        // When
        const result = await context
            .createCoordinator(
                providerFromRequests((request) => {
                    requests.push([...messageContents(request.messages)]);
                    return Promise.resolve();
                }),
            )
            .run();

        // Then
        expect(result).toMatchObject({ status: 'completed', turns: 1 });
        expect(requests).toEqual([[]]);
        await context.store.close();
    });

    it('coalesces pending steering inputs into one safe-boundary provider turn', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_coalesced_steer');
        const requests: string[][] = [];
        const coordinator = context.createCoordinator(
            providerFromRequests((request) => {
                requests.push([...messageContents(request.messages)]);
                return Promise.resolve();
            }),
        );

        // When
        await coordinator.steer({ inputId: 'input_first', messageId: 'message_first', prompt: 'first steer' });
        await coordinator.steer({ inputId: 'input_second', messageId: 'message_second', prompt: 'second steer' });
        await coordinator.wake();

        // Then
        expect(requests).toEqual([['first steer', 'second steer']]);
        await context.store.close();
    });

    it('persists durable provider settlements through the coordinator drain', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_provider_settlement');
        const coordinator = context.createCoordinator({
            async *streamTurn(request) {
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'tool_call_1',
                        toolName: 'repo.read',
                        argumentsJson: '{}',
                    },
                };
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 2,
                    message: { messageId: 'assistant_settlement', role: 'assistant', content: 'done' },
                    finishReason: 'stop',
                };
            },
        });

        // When
        await coordinator.run();
        const events = await context.events();

        // Then
        expect(events.some((event) => event.providerStreamChunk?.kind === 'tool_call_completed')).toBe(true);
        expect(events.some((event) => event.providerStreamChunk?.kind === 'response_completed')).toBe(true);
        await context.store.close();
    });

    it('continues a provider turn with a model-visible tool result after settlement', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_tool_continuation');
        const registry = createReadToolRegistry('README contents');
        const requests: ProviderTurnRequest[] = [];
        const coordinator = context.createCoordinator(
            {
                async *streamTurn(request) {
                    requests.push(request);
                    if (requests.length === 1) {
                        yield toolCallChunk(request, 'read_call_1', 'repo.read', { path: 'README.md' });
                        yield completedChunk(request, 'need README', ['read_call_1']);
                        return;
                    }
                    const toolMessage = request.messages.find((message) => message.role === 'tool');
                    yield completedChunk(request, `final after ${toolMessage?.output ?? 'missing tool output'}`);
                },
            },
            { toolRegistry: registry },
        );
        await coordinator.steer({
            inputId: 'input_read',
            messageId: 'message_read',
            prompt: 'read README',
        });

        // When
        const result = await coordinator.wake();
        const events = await context.events();

        // Then
        expect(result).toMatchObject({ status: 'completed', turns: 1 });
        expect(requests).toHaveLength(2);
        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['repo.read']);
        expect(requests[1]?.messages).toEqual([
            { role: 'user', content: 'read README' },
            { role: 'assistant', content: 'need README' },
            { role: 'tool', toolCallId: 'read_call_1', status: 'completed', output: 'README contents' },
        ]);
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['tool.completed', 'model.call.completed', 'run.completed']),
        );
        expect(events.at(-2)).toMatchObject({
            type: 'model.call.completed',
            message: 'final after README contents',
        });
        await context.store.close();
    });

    it('fails a provider continuation loop that exceeds the configured tool loop cap', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_tool_loop_cap');
        const registry = createReadToolRegistry('loop output');
        const requests: ProviderTurnRequest[] = [];
        const coordinator = context.createCoordinator(
            {
                async *streamTurn(request) {
                    requests.push(request);
                    const toolCallId = `read_call_${requests.length}`;
                    yield toolCallChunk(request, toolCallId, 'repo.read', { path: 'README.md' });
                    yield completedChunk(request, 'need another read', [toolCallId]);
                },
            },
            { toolRegistry: registry, toolCallLoopLimit: 1 },
        );
        await coordinator.steer({
            inputId: 'input_loop',
            messageId: 'message_loop',
            prompt: 'loop forever',
        });

        // When / Then
        await expect(coordinator.wake()).rejects.toThrow('provider turn tool loop limit exceeded: 1');
        expect(requests).toHaveLength(2);
        await context.store.close();
    });

    it('records active run commands when callers join an existing drain', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_active_commands');
        const started = deferred<void>();
        const release = deferred<void>();
        const coordinator = context.createCoordinator(
            providerFromRequests(() => {
                started.resolve();
                return release.promise;
            }),
        );
        await coordinator.steer({ inputId: 'input_join', messageId: 'message_join', prompt: 'join me' });

        // When
        const wake = coordinator.wake();
        await started.promise;
        const joinedRun = coordinator.run();
        release.resolve();
        await wake;
        await joinedRun;
        const commands = (await context.events()).flatMap((event) =>
            event.type === 'run.command.received' && event.run?.command !== undefined ? [event.run.command] : [],
        );

        // Then
        expect(commands).toEqual(expect.arrayContaining(['steer', 'wake', 'run']));
        await context.store.close();
    });

    it('records idle interrupt as idle state', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_idle_interrupt');
        const coordinator = context.createCoordinator(providerFromRequests(() => Promise.resolve()));

        // When
        const result = await coordinator.interrupt();
        const interruptEvent = (await context.events()).find((event) => event.type === 'run.command.received');

        // Then
        expect(result.status).toBe('idle');
        expect(interruptEvent?.run).toMatchObject({ command: 'interrupt', state: 'idle' });
        await context.store.close();
    });

    it('interrupts a running provider turn before another settlement can happen', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_interrupt');
        let providerSignal: AbortSignal | undefined;
        let iteratorClosed = false;
        const started = deferred<void>();
        const cleanupFinished = deferred<void>();
        const coordinator = context.createCoordinator({
            streamTurn(_request, runContext) {
                providerSignal = runContext.signal;
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            next() {
                                started.resolve();
                                return new Promise<IteratorResult<ProviderStreamChunk>>(() => {});
                            },
                            return() {
                                iteratorClosed = true;
                                return cleanupFinished.promise.then(() => ({ done: true, value: undefined }));
                            },
                        };
                    },
                };
            },
        });
        await coordinator.steer({ inputId: 'input_interrupt', messageId: 'message_interrupt', prompt: 'stop me' });

        // When
        const wake = coordinator.wake();
        await started.promise;
        const interrupt = coordinator.interrupt();
        expect(iteratorClosed).toBe(true);
        let interruptSettled = false;
        interrupt.then(() => {
            interruptSettled = true;
        });
        await Promise.resolve();
        expect(interruptSettled).toBe(false);
        cleanupFinished.resolve();
        const [result] = await Promise.all([wake, interrupt]);
        const events = await context.events();

        // Then
        expect(result.status).toBe('interrupted');
        expect(providerSignal?.aborted).toBe(true);
        expect(iteratorClosed).toBe(true);
        expect(events.some((event) => event.providerStreamChunk?.kind === 'tool_call_completed')).toBe(false);
        await context.store.close();
    });
});

function createReadToolRegistry(content: string): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        name: 'repo.read',
        description: 'Read a test repository file.',
        capabilityClasses: ['read'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        outputSchema: z.object({ content: z.string() }).strict(),
        outputLimit: { maxModelOutputChars: 1_000 },
        execute: () => ({ content }),
        toModelOutput: (output) => output.content,
    });
    return registry;
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(args),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `assistant_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}
