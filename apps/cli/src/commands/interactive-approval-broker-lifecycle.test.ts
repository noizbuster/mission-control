import { PermissionSession } from '@mission-control/core';
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';

type PermissionEvaluation = Awaited<ReturnType<PermissionSession['evaluate']>>;

type PendingEvaluation = {
    readonly requestId: string;
    readonly resolve: (evaluation: PermissionEvaluation) => void;
};

type Deferred<Value> = {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
};

class DeferredPermissionSession extends PermissionSession {
    private readonly evaluations: PendingEvaluation[] = [];

    override evaluate(request: PermissionRequest, _sessionId: string): Promise<PermissionEvaluation> {
        const evaluation = deferred<PermissionEvaluation>();
        this.evaluations.push({ requestId: request.id, resolve: evaluation.resolve });
        return evaluation.promise;
    }

    releaseAll(): void {
        for (const evaluation of this.evaluations.splice(0)) {
            evaluation.resolve(requiresApproval(evaluation.requestId));
        }
    }

    hasDeferredEvaluation(): boolean {
        return this.evaluations.length > 0;
    }
}

describe('interactive approval broker request lifecycle', () => {
    it.each(['once', 'yes'] as const)('rejects pre-request %s without authorizing a later request', async (answer) => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker } = brokerHarness(session);

        // When
        const acceptedBeforeRequest = broker.answer(answer);
        const decision = broker.requestPermission(patchRequest(`permission_pre_request_${answer}`));
        session.releaseAll();
        await Promise.resolve();
        if (broker.hasPending()) broker.answer('deny');

        // Then
        expect(acceptedBeforeRequest).toBe(false);
        await expect(decision).resolves.toMatchObject({ status: 'deny' });
    });

    it('cancellation during deferred evaluation denies without emitting a permission lifecycle', async () => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker, events, output } = brokerHarness(session);
        const decision = broker.requestPermission(patchRequest('permission_cancel_during_evaluation'));

        // When
        broker.cancel('turn cancelled');
        session.releaseAll();

        // Then
        await expect(decision).resolves.toMatchObject({ status: 'deny', reason: 'turn cancelled' });
        expect(events).toEqual([]);
        expect(output()).toBe('');
    });

    it('queues a concurrent requires_approval request and processes it after the first settles', async () => {
        const session = new DeferredPermissionSession();
        const { broker } = brokerHarness(session);
        const first = broker.requestPermission(patchRequest('permission_concurrent_first'));
        const second = broker.requestPermission(patchRequest('permission_concurrent_second'));

        const acceptedBeforeVisibility = broker.answer('once');
        session.releaseAll();
        await Promise.resolve();

        expect(acceptedBeforeVisibility).toBe(false);
        expect(broker.hasPending()).toBe(true);
        broker.answer('deny');
        await expect(first).resolves.toMatchObject({ status: 'deny' });

        await flushMicrotasks();
        session.releaseAll();
        await flushMicrotasks();
        expect(broker.hasPending()).toBe(true);
        broker.answer('deny');

        await expect(second).resolves.toMatchObject({ status: 'deny' });
    });

    it('settles one visible request once and preserves lifecycle event order', async () => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker, events } = brokerHarness(session);
        const decision = broker.requestPermission(patchRequest('permission_visible_once'));
        session.releaseAll();
        await Promise.resolve();

        // When
        const accepted = broker.answer('once');
        const acceptedAgain = broker.answer('deny');

        // Then
        expect(accepted).toBe(true);
        expect(acceptedAgain).toBe(false);
        await expect(decision).resolves.toMatchObject({ status: 'allow' });
        expect(events.map((event) => event.type)).toEqual([
            'permission.requested',
            'approval.requested',
            'permission.replied',
            'approval.updated',
            'approval.resumed',
        ]);
    });

    it('cancellation clears a primed approval before the next request', async () => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker, events } = brokerHarness(session);
        broker.primeApproval(patchRequest('permission_primed_before_cancel'), 'preview approved');

        // When
        broker.cancel('preview cancelled');
        const decision = broker.requestPermission(patchRequest('permission_primed_before_cancel'));
        if (session.hasDeferredEvaluation()) session.releaseAll();
        await Promise.resolve();
        if (broker.hasPending()) broker.answer('once');

        // Then
        await expect(decision).resolves.toMatchObject({ status: 'allow', reason: 'interactive CLI approval' });
        expect(events.map((event) => event.type)).toEqual([
            'permission.requested',
            'approval.requested',
            'permission.replied',
            'approval.updated',
            'approval.resumed',
        ]);
    });

    it('does not leak cancellation authority to the next request', async () => {
        const session = new DeferredPermissionSession();
        const { broker } = brokerHarness(session);
        broker.cancel('previous turn cancelled');

        const decision = broker.requestPermission(patchRequest('permission_after_cancel'));
        session.releaseAll();
        await Promise.resolve();
        const accepted = broker.answer('once');

        expect(accepted).toBe(true);
        await expect(decision).resolves.toMatchObject({ status: 'allow', reason: 'interactive CLI approval' });
    });

    it('auto-allows a rule-resolved read while a patch approval is visible', async () => {
        const session = new PermissionSession({
            builtInRules: [
                { permission: 'read', pattern: '*', decision: 'always' },
                { permission: 'patch', pattern: '*', decision: 'ask' },
            ],
        });
        const { broker } = brokerHarness(session);

        const patchPromise = broker.requestPermission(patchRequest('permission_patch_while_read'));
        await flushMicrotasks();
        expect(broker.hasPending()).toBe(true);

        const readPromise = broker.requestPermission(readRequest('permission_read_while_patch'));
        await expect(readPromise).resolves.toMatchObject({ status: 'allow' });

        broker.answer('deny');
        await expect(patchPromise).resolves.toMatchObject({ status: 'deny' });
    });

    it('auto-allows a queued request when the first answer was "always" for the same pattern', async () => {
        const session = new PermissionSession({
            builtInRules: [{ permission: 'patch', pattern: '*', decision: 'ask' }],
        });
        const { broker } = brokerHarness(session);

        const first = broker.requestPermission(patchRequest('permission_always_queue_first'));
        await flushMicrotasks();
        expect(broker.hasPending()).toBe(true);

        const second = broker.requestPermission(patchRequest('permission_always_queue_second'));
        await flushMicrotasks();

        broker.answer('always');
        await expect(first).resolves.toMatchObject({ status: 'allow' });

        await expect(second).resolves.toMatchObject({ status: 'allow' });
        expect(broker.hasPending()).toBe(false);
    });

    it('denies queued requests on cancel', async () => {
        const session = new DeferredPermissionSession();
        const { broker } = brokerHarness(session);

        const first = broker.requestPermission(patchRequest('permission_cancel_queued_first'));
        session.releaseAll();
        await flushMicrotasks();
        expect(broker.hasPending()).toBe(true);

        const second = broker.requestPermission(patchRequest('permission_cancel_queued_second'));
        await flushMicrotasks();

        broker.cancel('turn cancelled');
        session.releaseAll();
        await flushMicrotasks();

        await expect(first).resolves.toMatchObject({ status: 'deny', reason: 'turn cancelled' });
        await expect(second).resolves.toMatchObject({ status: 'deny', reason: 'turn cancelled' });
    });
});

function brokerHarness(permissionSession: PermissionSession) {
    const events: AgentEvent[] = [];
    let output = '';
    const broker = createInteractiveApprovalBroker(
        {
            workspaceRoot: '/workspace',
            sessionId: 'session_cli_approval_lifecycle',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            output: {
                write: (text) => {
                    output += text;
                },
            },
            emitEvent: (event) => events.push(event),
        },
        permissionSession,
    );
    return { broker, events, output: () => output };
}

function requiresApproval(requestId: string): PermissionEvaluation {
    const decision = {
        requestId,
        status: 'requires_approval',
        reason: 'test policy requires approval',
    } satisfies PermissionDecision;
    return { decision, consumeOnceRules: [] };
}

function patchRequest(id: string): PermissionRequest {
    return {
        id,
        action: 'file.patch',
        reason: 'apply patch',
        permission: { kind: 'patch', patterns: ['src/app.ts'] },
    };
}

function readRequest(id: string): PermissionRequest {
    return {
        id,
        action: 'repo.read',
        reason: 'read file',
        permission: { kind: 'read', patterns: ['src/app.ts'] },
    };
}

function deferred<Value>(): Deferred<Value> {
    let resolveValue: ((value: Value) => void) | undefined;
    const promise = new Promise<Value>((resolve) => {
        resolveValue = resolve;
    });
    if (resolveValue === undefined) throw new BrokerLifecycleTestError('deferred initialization failed');
    return { promise, resolve: resolveValue };
}

class BrokerLifecycleTestError extends Error {
    readonly name = 'BrokerLifecycleTestError';
}

async function flushMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
