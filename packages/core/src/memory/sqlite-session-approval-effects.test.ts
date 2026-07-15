import { describe, expect, it } from 'vitest';
import type { DesktopApprovalEffect } from '../desktop-approval-effect.js';
import { openLocalSessionEventStore } from './local-session-store.js';
import { tempDataDir } from './local-session-store-test-support.js';

const REQUESTED_AT = '2026-07-15T00:00:00.000Z';
const BEFORE_LEASE = '2026-07-15T00:00:30.000Z';
const LIVE_LEASE = '2026-07-15T00:01:00.000Z';
const AFTER_LEASE = '2026-07-15T00:02:00.000Z';

describe('SQLite desktop approval effect lifecycle', () => {
    it('claims once with full identity and rejects a duplicate while the lease is live', async () => {
        // Given: one pending effect in a real file-backed libSQL store.
        const dataDir = await tempDataDir('approval-effect-live-lease');
        const effect = approvalEffect('session_effect_live', 'approval_effect_live');
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => REQUESTED_AT,
        });
        await store.reserveDesktopApprovalEffect(effect);

        // When: two execution tokens try to claim the same full identity.
        const first = await store.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_first',
            leaseExpiresAt: LIVE_LEASE,
        });
        const duplicate = await store.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_duplicate',
            leaseExpiresAt: LIVE_LEASE,
        });
        await store.close();

        // Then: only the first token owns execution and the duplicate cannot replay it.
        expect(first).toMatchObject({ status: 'claimed', record: { state: 'executing' } });
        expect(duplicate).toMatchObject({
            status: 'executing',
            record: { executionToken: 'execution_token_first', leaseExpiresAt: LIVE_LEASE },
        });
    });

    it('rejects a claim whose identity differs from the reserved effect', async () => {
        // Given: a pending effect reserved under one immutable identity.
        const dataDir = await tempDataDir('approval-effect-identity');
        const effect = approvalEffect('session_effect_identity', 'approval_effect_identity');
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => REQUESTED_AT,
        });
        await store.reserveDesktopApprovalEffect(effect);

        // When: a claim substitutes the tool arguments while retaining the primary key.
        const result = await store.claimDesktopApprovalEffect({
            effect: { ...effect, argumentsJson: '{"path":"substituted"}' },
            executionToken: 'execution_token_mismatch',
            leaseExpiresAt: LIVE_LEASE,
        });
        await store.close();

        // Then: storage reports the mismatch rather than executing either identity.
        expect(result).toEqual({ status: 'identity_mismatch' });
    });

    it('rejects a claim whose lease does not extend beyond its claim time', async () => {
        const dataDir = await tempDataDir('approval-effect-invalid-lease');
        const effect = approvalEffect('session_effect_invalid_lease', 'approval_effect_invalid_lease');
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => REQUESTED_AT,
        });
        await store.reserveDesktopApprovalEffect(effect);

        await expect(
            store.claimDesktopApprovalEffect({
                effect,
                executionToken: 'execution_token_invalid_lease',
                leaseExpiresAt: REQUESTED_AT,
            }),
        ).rejects.toThrow('execution lease must expire after the claim time');
        await expect(store.getDesktopApprovalEffect(effect.approvalId)).resolves.toMatchObject({ state: 'pending' });
        await store.close();
    });

    it('rejects effect mutations addressed to a session other than the store session', async () => {
        const dataDir = await tempDataDir('approval-effect-store-session');
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: 'session_effect_store_owner',
            now: () => REQUESTED_AT,
        });
        const foreignEffect = approvalEffect('session_effect_foreign', 'approval_effect_foreign');

        await expect(store.reserveDesktopApprovalEffect(foreignEffect)).rejects.toThrow(
            'desktop approval effect session does not match the store session',
        );
        await expect(
            store.claimDesktopApprovalEffect({
                effect: foreignEffect,
                executionToken: 'execution_token_foreign',
                leaseExpiresAt: LIVE_LEASE,
            }),
        ).rejects.toThrow('desktop approval effect session does not match the store session');
        await expect(
            store.settleDesktopApprovalEffect({
                effect: foreignEffect,
                executionToken: 'execution_token_foreign',
                outcome: 'completed',
            }),
        ).rejects.toThrow('desktop approval effect session does not match the store session');
        await store.close();
    });

    it('recovers an expired execution to unknown and never makes it executable again', async () => {
        // Given: a claimed effect whose process disappears before terminal settlement.
        const dataDir = await tempDataDir('approval-effect-expired');
        const effect = approvalEffect('session_effect_expired', 'approval_effect_expired');
        const firstProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => REQUESTED_AT,
        });
        await firstProcess.reserveDesktopApprovalEffect(effect);
        await firstProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_expired',
            leaseExpiresAt: LIVE_LEASE,
        });
        await firstProcess.close();

        // When: a later process opens after the execution lease expired and tries to claim again.
        const recoveredProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => AFTER_LEASE,
        });
        const recovered = await recoveredProcess.getDesktopApprovalEffect(effect.approvalId);
        const replay = await recoveredProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_replay',
            leaseExpiresAt: '2026-07-15T00:03:00.000Z',
        });
        await recoveredProcess.close();

        // Then: the ambiguous execution is terminally unknown and a retry never receives authority.
        expect(recovered).toMatchObject({ state: 'unknown', unknownAt: AFTER_LEASE });
        expect(replay).toMatchObject({ status: 'unknown', record: { state: 'unknown' } });
    });

    it.each([
        'completed',
        'failed',
    ] as const)('settles a known %s outcome only with the claiming token', async (outcome) => {
        // Given: one live executing effect.
        const dataDir = await tempDataDir(`approval-effect-settle-${outcome}`);
        const effect = approvalEffect(`session_effect_${outcome}`, `approval_effect_${outcome}`);
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => BEFORE_LEASE,
        });
        await store.reserveDesktopApprovalEffect(effect);
        await store.claimDesktopApprovalEffect({
            effect,
            executionToken: `execution_token_${outcome}`,
            leaseExpiresAt: LIVE_LEASE,
        });

        // When: a stale token and then the owning token attempt terminal settlement.
        const stale = await store.settleDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_stale',
            outcome,
        });
        const owned = await store.settleDesktopApprovalEffect({
            effect,
            executionToken: `execution_token_${outcome}`,
            outcome,
        });
        const record = await store.getDesktopApprovalEffect(effect.approvalId);
        await store.close();

        // Then: only the token-fenced transition records the known outcome.
        expect(stale).toBe(false);
        expect(owned).toBe(true);
        expect(record).toMatchObject({ state: 'settled', outcome, settledAt: BEFORE_LEASE });
    });

    it('rejects settlement by the owning token after its execution lease expires', async () => {
        const dataDir = await tempDataDir('approval-effect-expired-settlement');
        const effect = approvalEffect('session_effect_expired_settlement', 'approval_effect_expired_settlement');
        let currentNow = REQUESTED_AT;
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => currentNow,
        });
        await store.reserveDesktopApprovalEffect(effect);
        await store.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_expired_settlement',
            leaseExpiresAt: LIVE_LEASE,
        });
        currentNow = AFTER_LEASE;

        const settled = await store.settleDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_expired_settlement',
            outcome: 'completed',
        });
        const record = await store.getDesktopApprovalEffect(effect.approvalId);
        await store.close();

        expect(settled).toBe(false);
        expect(record).toMatchObject({ state: 'executing', executionToken: 'execution_token_expired_settlement' });
    });

    it('resolves unknown explicitly without returning it to execution', async () => {
        // Given: crash recovery has classified an expired execution as unknown.
        const dataDir = await tempDataDir('approval-effect-resolution');
        const effect = approvalEffect('session_effect_resolution', 'approval_effect_resolution');
        const firstProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => REQUESTED_AT,
        });
        await firstProcess.reserveDesktopApprovalEffect(effect);
        await firstProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_resolution',
            leaseExpiresAt: LIVE_LEASE,
        });
        await firstProcess.close();
        const operatorProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => AFTER_LEASE,
        });

        // When: an operator records that the ambiguous effect completed.
        const resolved = await operatorProcess.resolveDesktopApprovalEffect({
            approvalId: effect.approvalId,
            outcome: 'completed',
            resolvedAt: '2026-07-15T00:04:00.000Z',
        });
        const replay = await operatorProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_after_resolution',
            leaseExpiresAt: '2026-07-15T00:05:00.000Z',
        });
        await operatorProcess.close();

        // Then: resolution is durable metadata on unknown and cannot authorize execution.
        expect(resolved).toMatchObject({
            state: 'unknown',
            outcome: 'completed',
            resolvedAt: '2026-07-15T00:04:00.000Z',
        });
        expect(replay).toMatchObject({ status: 'unknown', record: { state: 'unknown', outcome: 'completed' } });
    });
});

function approvalEffect(sessionId: string, approvalId: string): DesktopApprovalEffect {
    return {
        sessionId,
        approvalId,
        runId: `run_${approvalId}`,
        toolCallId: `call_${approvalId}`,
        toolName: 'command.run',
        argumentsJson: '{"command":"node","args":["--version"]}',
        workspaceRoot: '/workspace',
    };
}
