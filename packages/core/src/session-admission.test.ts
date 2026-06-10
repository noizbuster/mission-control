import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import { projectSessionAdmission, SessionAdmissionError, SessionAdmissionService } from './session-admission.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('SessionAdmissionService', () => {
    it('records admitted prompts durably before model-visible promotion', async () => {
        // Given
        const context = await openAdmissionContext('session_admitted_before_promotion');

        // When
        await context.service.admitPrompt({
            inputId: 'input_1',
            messageId: 'message_1',
            prompt: 'persist before provider call',
            delivery: 'steer',
            resume: false,
        });
        await context.store.close();
        const reopenedStore = await JsonlSessionEventStore.open({
            sessionId: context.sessionId,
            dataDir: context.dataDir,
        });

        // Then
        const projection = projectSessionAdmission(await reopenedStore.getEvents(context.sessionId), context.sessionId);
        expect(projection.pendingInputs).toMatchObject([
            {
                inputId: 'input_1',
                messageId: 'message_1',
                prompt: 'persist before provider call',
                delivery: 'steer',
            },
        ]);
        expect(projection.modelVisibleMessages).toEqual([]);
        await reopenedStore.close();
    });

    it('keeps queued follow-ups outside model-visible history until explicit run promotion', async () => {
        // Given
        const context = await openAdmissionContext('session_queue_semantics');
        await context.service.admitPrompt({
            inputId: 'input_queue',
            messageId: 'message_queue',
            prompt: 'queued follow-up',
            delivery: 'queue',
        });

        // When
        const wakeResult = await context.service.requestWake();
        const beforeRun = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const runResult = await context.service.requestRun();
        const afterRun = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);

        // Then
        expect(wakeResult).toEqual({ kind: 'idle' });
        expect(beforeRun.modelVisibleMessages).toEqual([]);
        expect(runResult.kind).toBe('promoted');
        expect(afterRun.modelVisibleMessages).toMatchObject([
            {
                messageId: 'message_queue',
                content: 'queued follow-up',
            },
        ]);
        await context.store.close();
    });

    it('promotes steering input on wake and distinguishes explicit run without input', async () => {
        // Given
        const context = await openAdmissionContext('session_wake_run_semantics');
        await context.service.admitPrompt({
            inputId: 'input_steer',
            messageId: 'message_steer',
            prompt: 'steer next turn',
            delivery: 'steer',
        });

        // When
        const wakeResult = await context.service.requestWake();
        const runResult = await context.service.requestRun();

        // Then
        expect(wakeResult).toMatchObject({
            kind: 'promoted',
            trigger: 'wake',
            messageId: 'message_steer',
        });
        expect(runResult).toEqual({ kind: 'run_requested' });
        await context.store.close();
    });

    it('creates transcript branches with parent links and active leaf updates', async () => {
        // Given
        const context = await openAdmissionContext('session_branch_admission');
        await context.service.admitPrompt({
            inputId: 'input_root',
            messageId: 'message_root',
            prompt: 'root prompt',
            delivery: 'steer',
        });
        await context.service.requestWake();

        // When
        await context.service.admitPrompt({
            inputId: 'input_branch',
            messageId: 'message_branch',
            parentMessageId: 'message_root',
            prompt: 'branch prompt',
            delivery: 'steer',
        });
        await context.service.requestWake();
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);

        // Then
        expect(projection.branchTree.activeLeafMessageId).toBe('message_branch');
        expect(projection.branchTree.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    messageId: 'message_root',
                    childMessageIds: ['message_branch'],
                }),
            ]),
        );
        await context.store.close();
    });

    it('resumes a queued prompt after interruption and restart', async () => {
        // Given
        const context = await openAdmissionContext('session_restart_resume');
        await context.service.admitPrompt({
            inputId: 'input_first',
            messageId: 'message_first',
            prompt: 'first prompt',
            delivery: 'steer',
        });
        await context.service.requestWake();
        await context.service.admitPrompt({
            inputId: 'input_second',
            messageId: 'message_second',
            prompt: 'second prompt',
            delivery: 'queue',
            resume: false,
        });
        await context.store.close();
        const restartedStore = await JsonlSessionEventStore.open({
            sessionId: context.sessionId,
            dataDir: context.dataDir,
        });
        const restartedService = new SessionAdmissionService({
            sessionId: context.sessionId,
            store: restartedStore,
            now: () => '2026-06-06T10:00:10.000Z',
        });

        // When
        const beforeRun = projectSessionAdmission(await restartedStore.getEvents(context.sessionId), context.sessionId);
        const runResult = await restartedService.requestRun();
        const afterRun = projectSessionAdmission(await restartedStore.getEvents(context.sessionId), context.sessionId);

        // Then
        expect(beforeRun.pendingInputs.map((input) => input.inputId)).toEqual(['input_second']);
        expect(runResult).toMatchObject({
            kind: 'promoted',
            trigger: 'run',
            messageId: 'message_second',
        });
        expect(afterRun.modelVisibleMessages.map((message) => message.content)).toEqual([
            'first prompt',
            'second prompt',
        ]);
        await restartedStore.close();
    });

    it('rejects reusing a promoted input id instead of returning an unpromotable receipt', async () => {
        // Given
        const context = await openAdmissionContext('session_promoted_duplicate');
        await context.service.admitPrompt({
            inputId: 'input_duplicate',
            messageId: 'message_duplicate',
            prompt: 'first durable prompt',
            delivery: 'queue',
        });
        await context.service.requestRun();

        // When
        const duplicateAdmission = context.service.admitPrompt({
            inputId: 'input_duplicate',
            messageId: 'message_duplicate',
            prompt: 'first durable prompt',
            delivery: 'queue',
        });

        // Then
        await expect(duplicateAdmission).rejects.toMatchObject({
            code: 'input_conflict',
        });
        await expect(duplicateAdmission).rejects.toBeInstanceOf(SessionAdmissionError);
        expect(
            projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId).pendingInputs,
        ).toEqual([]);
        await context.store.close();
    });
});

async function openAdmissionContext(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly dataDir: string;
    readonly store: JsonlSessionEventStore;
    readonly service: SessionAdmissionService;
}> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-admission-'));
    tempDirs.push(dataDir);
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: () => '2026-06-06T10:00:00.000Z',
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
    return {
        sessionId,
        dataDir,
        store,
        service: new SessionAdmissionService({
            sessionId,
            store,
            now: () => '2026-06-06T10:00:00.000Z',
        }),
    };
}
