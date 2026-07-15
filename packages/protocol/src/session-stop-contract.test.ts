import { describe, expect, it } from 'vitest';
import {
    AgentEventLogSchema,
    AgentEventSchema,
    PROTOCOL_ERROR_CODES,
    SESSION_STOP_BARRIER_KINDS,
    SESSION_STOP_ERROR_CODES,
    SESSION_STOP_OUTCOMES,
    SESSION_STOP_SCOPES,
    SessionStatusSchema,
    SessionStopBarrierKindSchema,
    SessionStopErrorCodeSchema,
    SessionStopOutcomeSchema,
    SessionStopScopeSchema,
    ToolResultSchema,
} from './index';
import {
    abortCompletedEvent,
    activeStopEventFixture,
    correlatedLegacyInterruptedRunEvent,
    noRunStopEventFixture,
    operatorAbortedRunEvent,
    persistedLegacyEventLog,
    promptCancelledEvent,
} from './session-stop-contract-test-support';

describe('durable session stop protocol', () => {
    it('parses prompt cancellation with durable input identity and operator reason', () => {
        const event = AgentEventSchema.parse(promptCancelledEvent());

        expect(event.transcript).toEqual({
            inputId: 'input_queued',
            delivery: 'queue',
            requestId: 'request_stop',
            reason: 'operator_aborted',
        });
    });

    it('preserves other valid transcript links on prompt cancellation', () => {
        const prompt = promptCancelledEvent();
        const event = AgentEventSchema.parse({
            ...prompt,
            transcript: {
                ...prompt.transcript,
                messageId: 'message_cancelled',
                visibility: 'pending',
            },
        });

        expect(event.transcript).toMatchObject({
            messageId: 'message_cancelled',
            visibility: 'pending',
            reason: 'operator_aborted',
        });
    });

    it('parses the nonterminal abort-completed marker and affected entity counts', () => {
        const event = AgentEventSchema.parse(abortCompletedEvent());

        expect(event.sessionStop).toMatchObject({
            operationId: 'operation_stop',
            requestId: 'request_stop',
            reason: 'operator_aborted',
            affected: {
                runs: 1,
                sessionInputs: 1,
                asyncJobs: 1,
            },
        });
        expect(SessionStatusSchema.safeParse('aborted').success).toBe(false);
        expect(SessionStatusSchema.safeParse('cancelled').success).toBe(false);
    });

    it('parses structured operator-aborted run interruption metadata', () => {
        const event = AgentEventSchema.parse(operatorAbortedRunEvent());

        expect(event.run).toMatchObject({
            state: 'interrupted',
            requestId: 'request_stop',
            operationId: 'operation_stop',
            reason: 'operator_aborted',
        });
    });

    it('preserves non-operator interruption correlation metadata', () => {
        const event = AgentEventSchema.parse(correlatedLegacyInterruptedRunEvent());

        expect(event.run).toMatchObject({
            requestId: 'request_legacy',
            operationId: 'operation_legacy',
            reason: 'user interrupted run',
        });
    });

    it('defines closed stop scope, barrier, outcome, and error vocabularies', () => {
        expect(SESSION_STOP_SCOPES).toEqual(['tree', 'only', 'children']);
        expect(SESSION_STOP_BARRIER_KINDS).toEqual(['all_mutations', 'child_spawn_only']);
        expect(SESSION_STOP_OUTCOMES).toEqual(['interrupted', 'already_idle', 'already_terminal', 'failed']);
        expect(SESSION_STOP_ERROR_CODES).toEqual([
            'session_not_found',
            'session_owned_elsewhere',
            'owner_unreachable',
            'session_stopping',
            'stop_timeout',
            'unstable_session_tree',
        ]);

        expect(SessionStopScopeSchema.parse('tree')).toBe('tree');
        expect(SessionStopBarrierKindSchema.parse('child_spawn_only')).toBe('child_spawn_only');
        expect(SessionStopOutcomeSchema.parse('already_idle')).toBe('already_idle');
        expect(SessionStopErrorCodeSchema.parse('owner_unreachable')).toBe('owner_unreachable');
    });

    it('rejects missing stop IDs, unknown vocabulary, and combined scopes', () => {
        const missingPromptRequestId = promptCancelledEvent();
        const missingAbortOperationId = abortCompletedEvent();
        const missingRunOperationId = operatorAbortedRunEvent();
        const { requestId: _requestId, ...promptWithoutRequestId } = missingPromptRequestId.transcript;
        const { operationId: _operationId, ...abortWithoutOperationId } = missingAbortOperationId.sessionStop;
        const { operationId: _runOperationId, ...runWithoutOperationId } = missingRunOperationId.run;

        expect(
            AgentEventSchema.safeParse({ ...missingPromptRequestId, transcript: promptWithoutRequestId }).success,
        ).toBe(false);
        expect(
            AgentEventSchema.safeParse({ ...missingAbortOperationId, sessionStop: abortWithoutOperationId }).success,
        ).toBe(false);
        expect(AgentEventSchema.safeParse({ ...missingRunOperationId, run: runWithoutOperationId }).success).toBe(
            false,
        );
        expect(SessionStopScopeSchema.safeParse('descendants').success).toBe(false);
        expect(SessionStopScopeSchema.safeParse(['only', 'children']).success).toBe(false);
        expect(SessionStopBarrierKindSchema.safeParse('none').success).toBe(false);
    });

    it('rejects incomplete affected counts and unknown structured run fields', () => {
        const marker = abortCompletedEvent();
        const run = operatorAbortedRunEvent();
        const { toolCalls: _toolCalls, ...incompleteAffected } = marker.sessionStop.affected;

        expect(
            AgentEventSchema.safeParse({
                ...marker,
                sessionStop: { ...marker.sessionStop, affected: incompleteAffected },
            }).success,
        ).toBe(false);
        expect(
            AgentEventSchema.safeParse({
                ...run,
                run: { ...run.run, unexpected: true },
            }).success,
        ).toBe(false);
    });

    it('locks exactly one interrupted event for active work and marker-only no-run cleanup', () => {
        const activeFixture = activeStopEventFixture().map((event) => AgentEventSchema.parse(event));
        const noRunFixture = noRunStopEventFixture().map((event) => AgentEventSchema.parse(event));

        expect(activeFixture.filter((event) => event.type === 'run.interrupted')).toHaveLength(1);
        expect(activeFixture.filter((event) => event.type === 'session.abort.completed')).toHaveLength(1);
        expect(noRunFixture.map((event) => event.type)).toEqual(['session.abort.completed']);
        expect(noRunFixture[0]?.sessionStop?.affected.runs).toBe(0);
    });

    it('replays persisted pre-feature events without requiring stop metadata', () => {
        const persistedLegacyEvents = persistedLegacyEventLog();

        const replayed = AgentEventLogSchema.parse(JSON.parse(persistedLegacyEvents));

        expect(replayed.map((entry) => entry.event.type)).toEqual(['prompt.admitted', 'run.interrupted']);
    });

    it('keeps tool results binary while allowing operator-aborted failures', () => {
        expect(PROTOCOL_ERROR_CODES).toContain('operator_aborted');
        expect(
            ToolResultSchema.parse({
                toolCallId: 'tool_call_active',
                status: 'failed',
                error: {
                    code: 'operator_aborted',
                    message: 'tool interrupted by the operator',
                    retryable: true,
                },
            }),
        ).toMatchObject({ status: 'failed', error: { code: 'operator_aborted' } });
        expect(
            ToolResultSchema.safeParse({
                toolCallId: 'tool_call_active',
                status: 'cancelled',
            }).success,
        ).toBe(false);
    });
});
