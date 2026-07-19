import { PermissionRuleStore, PermissionSession } from '@mission-control/core';
import type {
    AgentEvent,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
    PermissionRule,
} from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';

type Deferred<Value> = {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
};

class DeferredRejectingRuleStore extends PermissionRuleStore {
    private readonly started = deferred<void>();
    private readonly released = deferred<void>();

    override listRules(_workspaceRoot: string): Promise<readonly PermissionRule[]> {
        return Promise.resolve([]);
    }

    override async appendRules(): Promise<void> {
        this.started.resolve();
        await this.released.promise;
        throw new ApprovalPersistenceTestError();
    }

    waitUntilStarted(): Promise<void> {
        return this.started.promise;
    }

    reject(): void {
        this.released.resolve();
    }
}

class DeferredRememberPermissionSession extends PermissionSession {
    private readonly started = deferred<void>();
    private readonly released = deferred<void>();

    override async rememberReply(
        request: PermissionRequest,
        sessionId: string,
        reply: PermissionReply,
        options?: Parameters<PermissionSession['rememberReply']>[3],
    ): Promise<void> {
        this.started.resolve();
        await this.released.promise;
        await super.rememberReply(request, sessionId, reply, options);
    }

    waitUntilStarted(): Promise<void> {
        return this.started.promise;
    }

    release(): void {
        this.released.resolve();
    }
}

class DeferredAfterCommitPermissionSession extends PermissionSession {
    private readonly committed = deferred<void>();
    private readonly released = deferred<void>();

    override async rememberReply(
        request: PermissionRequest,
        sessionId: string,
        reply: PermissionReply,
        options?: Parameters<PermissionSession['rememberReply']>[3],
    ): Promise<void> {
        await super.rememberReply(request, sessionId, reply, options);
        this.committed.resolve();
        await this.released.promise;
    }

    waitUntilCommitted(): Promise<void> {
        return this.committed.promise;
    }

    release(): void {
        this.released.resolve();
    }
}

describe('interactive approval broker settlement', () => {
    it('denies exactly once when persisted authority storage rejects', async () => {
        // Given
        const store = new DeferredRejectingRuleStore();
        const session = new PermissionSession({ persistedRuleStore: store });
        const { broker, events, waitForPrompt } = brokerHarness(session);
        const request = patchRequest('permission_settlement_rejection');
        let observedDecision: PermissionDecision | undefined;
        void broker.requestPermission(request).then((decision) => {
            observedDecision = decision;
        });
        await waitForPrompt(1);
        expect(broker.answer('always')).toBe(true);
        await store.waitUntilStarted();

        // When
        store.reject();
        await flushMicrotasks();

        // Then
        expect(observedDecision).toMatchObject({
            requestId: request.id,
            status: 'deny',
            reason: 'approval settlement failed',
        });
        expect(settlementEventTypes(events)).toEqual(['permission.replied', 'approval.updated', 'approval.blocked']);
        expect(events.filter((event) => event.type === 'approval.resumed')).toHaveLength(0);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('makes cancellation dominant while reply authority is being remembered', async () => {
        // Given
        const session = new DeferredRememberPermissionSession();
        const { broker, events, waitForPrompt } = brokerHarness(session);
        const request = patchRequest('permission_settlement_cancel');
        const decision = broker.requestPermission(request);
        await waitForPrompt(1);
        expect(broker.answer('session')).toBe(true);
        await session.waitUntilStarted();

        // When
        broker.cancel('turn cancelled during settlement');
        session.release();

        // Then
        await expect(decision).resolves.toMatchObject({
            requestId: request.id,
            status: 'deny',
            reason: 'turn cancelled during settlement',
        });
        expect(settlementEventTypes(events)).toEqual(['permission.replied', 'approval.updated', 'approval.blocked']);
        expect(events.filter((event) => event.type === 'approval.resumed')).toHaveLength(0);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('accepts only the first answer while settlement is pending', async () => {
        // Given
        const session = new DeferredRememberPermissionSession();
        const { broker, events, waitForPrompt } = brokerHarness(session);
        const decision = broker.requestPermission(patchRequest('permission_settlement_once'));
        await waitForPrompt(1);

        // When
        const accepted = broker.answer('once');
        const acceptedAgain = broker.answer('deny');
        await session.waitUntilStarted();
        session.release();

        // Then
        expect(accepted).toBe(true);
        expect(acceptedAgain).toBe(false);
        await expect(decision).resolves.toMatchObject({ status: 'allow' });
        expect(settlementEventTypes(events)).toEqual(['permission.replied', 'approval.updated', 'approval.resumed']);
    });

    it('keeps a successful authority claim when cancellation arrives after commit', async () => {
        // Given
        const session = new DeferredAfterCommitPermissionSession();
        const { broker, events, waitForPrompt } = brokerHarness(session);
        const request = patchRequest('permission_settlement_post_commit_cancel');
        const decision = broker.requestPermission(request);
        await waitForPrompt(1);
        expect(broker.answer('session')).toBe(true);
        await session.waitUntilCommitted();

        // When
        broker.cancel('late cancellation');
        session.release();

        // Then
        await expect(decision).resolves.toMatchObject({ status: 'allow' });
        expect(settlementEventTypes(events)).toEqual(['permission.replied', 'approval.updated', 'approval.resumed']);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'allow' },
        });
    });

    it('accepts a new request after a failed settlement', async () => {
        // Given
        const store = new DeferredRejectingRuleStore();
        const session = new PermissionSession({ persistedRuleStore: store });
        const { broker, waitForPrompt } = brokerHarness(session);
        void broker.requestPermission(patchRequest('permission_failed_before_reuse'));
        await waitForPrompt(1);
        expect(broker.answer('always')).toBe(true);
        await store.waitUntilStarted();
        store.reject();
        await flushMicrotasks();

        // When
        const next = broker.requestPermission(patchRequest('permission_after_failed_settlement'));
        await waitForPrompt(2);

        // Then
        expect(broker.hasPending()).toBe(true);
        expect(broker.answer('once')).toBe(true);
        await expect(next).resolves.toMatchObject({ status: 'allow' });
    });
});

const SESSION_ID = 'session_cli_approval_settlement';

function brokerHarness(permissionSession: PermissionSession) {
    const events: AgentEvent[] = [];
    const prompts = approvalPromptTracker();
    const broker = createInteractiveApprovalBroker(
        {
            workspaceRoot: '/workspace',
            sessionId: SESSION_ID,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            output: { write: () => undefined, showApproval: prompts.show },
            emitEvent: (event) => events.push(event),
        },
        permissionSession,
    );
    return { broker, events, waitForPrompt: prompts.waitFor };
}

function patchRequest(id: string): PermissionRequest {
    return {
        id,
        action: 'file.patch',
        reason: 'apply patch',
        permission: { kind: 'patch', patterns: ['src/app.ts'], workspaceRoot: '/workspace' },
    };
}

function settlementEventTypes(events: readonly AgentEvent[]): readonly AgentEvent['type'][] {
    return events
        .map((event) => event.type)
        .filter((type) =>
            ['permission.replied', 'approval.updated', 'approval.blocked', 'approval.resumed'].includes(type),
        );
}

async function flushMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function deferred<Value>(): Deferred<Value> {
    let resolveValue = (_value: Value): void => undefined;
    const promise = new Promise<Value>((resolve) => {
        resolveValue = resolve;
    });
    return { promise, resolve: resolveValue };
}

function approvalPromptTracker() {
    let count = 0;
    const waiters = new Map<number, Deferred<void>>();
    return {
        show: () => {
            count += 1;
            waiters.get(count)?.resolve();
        },
        waitFor: (expected: number) => {
            if (count >= expected) return Promise.resolve();
            const waiter = deferred<void>();
            waiters.set(expected, waiter);
            return waiter.promise;
        },
    };
}

class ApprovalPersistenceTestError extends Error {
    readonly name = 'ApprovalPersistenceTestError';
}
