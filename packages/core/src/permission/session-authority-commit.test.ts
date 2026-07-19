import type { PermissionReply, PermissionRequest, PermissionRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { PermissionAuthorityCommitCancelledError, PermissionSession, type RememberReplyOptions } from './session';
import { type PermissionRuleAppendOptions, PermissionRuleStore } from './store';

class DeferredCommitRuleStore extends PermissionRuleStore {
    private readonly started = deferred<void>();
    private readonly released = deferred<void>();

    override listRules(_workspaceRoot: string): Promise<readonly PermissionRule[]> {
        return Promise.resolve([]);
    }

    override async appendRules(
        _rules: readonly PermissionRule[],
        options: PermissionRuleAppendOptions = {},
    ): Promise<void> {
        this.started.resolve();
        await this.released.promise;
        options.beforeCommit?.();
    }

    waitUntilStarted(): Promise<void> {
        return this.started.promise;
    }

    release(): void {
        this.released.resolve();
    }
}

describe('PermissionSession authority commit', () => {
    it('rejects a closed authority guard before installing a session rule', async () => {
        // Given
        const session = new PermissionSession();
        const request = patchRequest('permission_guard_closed');

        // When
        const remembering = session.rememberReply(request, SESSION_ID, sessionReply(), {
            tryCommitAuthority: () => false,
        });

        // Then
        await expect(remembering).rejects.toBeInstanceOf(PermissionAuthorityCommitCancelledError);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('observes cancellation that occurs while request normalization is pending', async () => {
        // Given
        const session = new PermissionSession();
        const request = patchRequest('permission_guard_during_normalization');
        let authorityOpen = true;
        const options: RememberReplyOptions = { tryCommitAuthority: () => authorityOpen };

        // When
        const remembering = session.rememberReply(request, SESSION_ID, sessionReply(), options);
        authorityOpen = false;

        // Then
        await expect(remembering).rejects.toBeInstanceOf(PermissionAuthorityCommitCancelledError);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('checks persisted authority immediately before the store commit', async () => {
        // Given
        const store = new DeferredCommitRuleStore();
        const session = new PermissionSession({ persistedRuleStore: store });
        const request = patchRequest('permission_guard_before_store_commit');
        let authorityOpen = true;
        const remembering = session.rememberReply(request, SESSION_ID, persistedReply(), {
            tryCommitAuthority: () => authorityOpen,
        });
        await store.waitUntilStarted();

        // When
        authorityOpen = false;
        store.release();

        // Then
        await expect(remembering).rejects.toBeInstanceOf(PermissionAuthorityCommitCancelledError);
        await expect(session.evaluate(request, SESSION_ID)).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });
});

const SESSION_ID = 'session_permission_authority_commit';

function patchRequest(id: string): PermissionRequest {
    return {
        id,
        action: 'file.patch',
        reason: 'apply patch',
        permission: { kind: 'patch', patterns: ['src/app.ts'], workspaceRoot: '/workspace' },
    };
}

function sessionReply(): PermissionReply {
    return { approvalId: 'approval_session', reply: 'always', reason: 'session approval' };
}

function persistedReply(): PermissionReply {
    return { approvalId: 'approval_persisted', reply: 'always', reason: 'persist approval', persist: true };
}

function deferred<Value>() {
    let resolveValue = (_value: Value): void => undefined;
    const promise = new Promise<Value>((resolve) => {
        resolveValue = resolve;
    });
    return { promise, resolve: resolveValue };
}
