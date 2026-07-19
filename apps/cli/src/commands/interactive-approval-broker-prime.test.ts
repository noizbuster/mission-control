import { PermissionSession } from '@mission-control/core';
import type { AgentEvent, PermissionDecision, PermissionKind, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';

type PermissionEvaluation = Awaited<ReturnType<PermissionSession['evaluate']>>;

type PendingEvaluation = {
    readonly requestId: string;
    readonly resolve: (evaluation: PermissionEvaluation) => void;
};

type RequestOverrides = {
    readonly action?: string;
    readonly reason?: string;
    readonly kind?: PermissionKind;
    readonly patterns?: string[];
    readonly workspaceRoot?: string;
};

type EffectMutation = {
    readonly name: string;
    readonly request: (id: string) => PermissionRequest;
};

const EFFECT_MUTATIONS = [
    { name: 'action', request: (id) => effectRequest(id, { action: 'file.write' }) },
    { name: 'reason', request: (id) => effectRequest(id, { reason: 'replace full file' }) },
    { name: 'permission kind', request: (id) => effectRequest(id, { kind: 'write' }) },
    { name: 'permission patterns', request: (id) => effectRequest(id, { patterns: ['src/changed.ts'] }) },
    {
        name: 'permission pattern order',
        request: (id) => effectRequest(id, { patterns: ['src/other.ts', 'src/app.ts'] }),
    },
    { name: 'permission workspace', request: (id) => effectRequest(id, { workspaceRoot: '/other-workspace' }) },
] satisfies readonly EffectMutation[];

class DeferredPermissionSession extends PermissionSession {
    private readonly evaluations: PendingEvaluation[] = [];
    private startedCount = 0;

    override evaluate(request: PermissionRequest, _sessionId: string): Promise<PermissionEvaluation> {
        const evaluation = deferred<PermissionEvaluation>();
        this.evaluations.push({ requestId: request.id, resolve: evaluation.resolve });
        this.startedCount += 1;
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

    evaluationsStarted(): number {
        return this.startedCount;
    }
}

describe('interactive approval broker primed request authority', () => {
    it('authorizes one identical request and evaluates the next identical request normally', async () => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker, events } = brokerHarness(session);
        const request = effectRequest('permission_identical_prime');
        broker.primeApproval(request, 'preview approved');

        // When
        const primedDecision = await broker.requestPermission(request);
        const nextDecision = broker.requestPermission(request);
        session.releaseAll();
        await Promise.resolve();
        if (broker.hasPending()) broker.answer('deny');

        // Then
        expect(primedDecision).toMatchObject({ status: 'allow', reason: 'preview approved' });
        await expect(nextDecision).resolves.toMatchObject({ status: 'deny' });
        expect(session.evaluationsStarted()).toBe(1);
        expect(events.map((event) => event.type)).toEqual([
            'permission.requested',
            'approval.requested',
            'permission.replied',
            'approval.updated',
            'approval.blocked',
        ]);
    });

    it.each(EFFECT_MUTATIONS)('does not authorize a reused ID with changed $name', async ({ request }) => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker, events } = brokerHarness(session);
        const requestId = 'permission_effect_mismatch';
        broker.primeApproval(effectRequest(requestId), 'preview approved');

        // When
        const decision = broker.requestPermission(request(requestId));
        if (session.hasDeferredEvaluation()) session.releaseAll();
        await Promise.resolve();
        const wasVisible = broker.hasPending();
        if (wasVisible) broker.answer('deny');

        // Then
        await expect(decision).resolves.toMatchObject({ status: 'deny' });
        expect(wasVisible).toBe(true);
        expect(session.evaluationsStarted()).toBe(1);
        expect(events.slice(0, 2).map((event) => event.type)).toEqual(['permission.requested', 'approval.requested']);
    });

    it('does not consume a prime when a mismatched request uses the same ID', async () => {
        // Given
        const session = new DeferredPermissionSession();
        const { broker } = brokerHarness(session);
        const primedRequest = effectRequest('permission_prime_survives_mismatch');
        broker.primeApproval(primedRequest, 'preview approved');

        // When
        const mismatch = broker.requestPermission(effectRequest(primedRequest.id, { reason: 'different effect' }));
        if (session.hasDeferredEvaluation()) session.releaseAll();
        await Promise.resolve();
        if (broker.hasPending()) broker.answer('deny');
        const mismatchDecision = await mismatch;
        const identicalDecision = broker.requestPermission(primedRequest);
        if (session.hasDeferredEvaluation()) session.releaseAll();
        await Promise.resolve();
        if (broker.hasPending()) broker.answer('deny');

        // Then
        expect(mismatchDecision).toMatchObject({ status: 'deny' });
        await expect(identicalDecision).resolves.toMatchObject({ status: 'allow', reason: 'preview approved' });
    });
});

function brokerHarness(permissionSession: PermissionSession) {
    const events: AgentEvent[] = [];
    const broker = createInteractiveApprovalBroker(
        {
            workspaceRoot: '/workspace',
            sessionId: 'session_cli_primed_approval',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            output: { write: () => undefined },
            emitEvent: (event) => events.push(event),
        },
        permissionSession,
    );
    return { broker, events };
}

function requiresApproval(requestId: string): PermissionEvaluation {
    const decision = {
        requestId,
        status: 'requires_approval',
        reason: 'test policy requires approval',
    } satisfies PermissionDecision;
    return { decision, consumeOnceRules: [] };
}

function effectRequest(id: string, overrides: RequestOverrides = {}): PermissionRequest {
    return {
        id,
        action: overrides.action ?? 'file.patch',
        reason: overrides.reason ?? 'apply patch',
        permission: {
            kind: overrides.kind ?? 'patch',
            patterns: overrides.patterns ?? ['src/app.ts', 'src/other.ts'],
            workspaceRoot: overrides.workspaceRoot ?? '/workspace',
        },
    };
}

function deferred<Value>() {
    let resolveValue = (_value: Value): void => undefined;
    const promise = new Promise<Value>((resolve) => {
        resolveValue = resolve;
    });
    return { promise, resolve: resolveValue };
}
