import type { Client } from '@libsql/client';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { desktopApprovalEffects } from '../db/schema';
import type {
    DesktopApprovalEffect,
    DesktopApprovalEffectClaimInput,
    DesktopApprovalEffectClaimResult,
    DesktopApprovalEffectExecutingRecord,
    DesktopApprovalEffectRecord,
    DesktopApprovalEffectResolutionInput,
    DesktopApprovalEffectSettlementInput,
} from '../desktop-approval-effect';
import { sameDesktopApprovalEffect } from '../desktop-approval-effect';
import { readSqliteDesktopApprovalEffect } from './sqlite-session-approval-effect-records';

export { readSqliteDesktopApprovalEffect } from './sqlite-session-approval-effect-records';

export async function reserveSqliteDesktopApprovalEffect(
    client: Client,
    effect: DesktopApprovalEffect,
    requestedAt: string,
): Promise<boolean> {
    const db = drizzleFromClient(client);
    const inserted = await db
        .insert(desktopApprovalEffects)
        .values({
            sessionId: effect.sessionId,
            approvalId: effect.approvalId,
            runId: effect.runId,
            toolCallId: effect.toolCallId,
            toolName: effect.toolName,
            argumentsJson: effect.argumentsJson,
            workspaceRoot: effect.workspaceRoot,
            state: 'pending',
            requestedAt,
        })
        .onConflictDoNothing();
    if (inserted.rowsAffected === 1) return true;
    const existing = await readSqliteDesktopApprovalEffect(client, effect.sessionId, effect.approvalId);
    return existing?.state === 'pending' && sameDesktopApprovalEffect(existing.effect, effect);
}

export async function claimSqliteDesktopApprovalEffect(
    client: Client,
    input: DesktopApprovalEffectClaimInput,
    now: string,
): Promise<DesktopApprovalEffectClaimResult> {
    const existing = await readSqliteDesktopApprovalEffect(client, input.effect.sessionId, input.effect.approvalId);
    if (existing === undefined) return { status: 'missing' };
    if (!sameDesktopApprovalEffect(existing.effect, input.effect)) return { status: 'identity_mismatch' };
    switch (existing.state) {
        case 'pending':
            return claimPendingEffect(client, input, now);
        case 'executing':
            if (existing.leaseExpiresAt > now) return { status: 'executing', record: existing };
            return recoverExpiredClaim(client, input, existing, now);
        case 'settled':
            return { status: 'settled', record: existing };
        case 'unknown':
            return { status: 'unknown', record: existing };
        default:
            return assertNeverEffectRecord(existing);
    }
}

export async function settleSqliteDesktopApprovalEffect(
    client: Client,
    input: DesktopApprovalEffectSettlementInput,
    settledAt: string,
): Promise<boolean> {
    const db = drizzleFromClient(client);
    const result = await db
        .update(desktopApprovalEffects)
        .set({
            state: 'settled',
            outcome: input.outcome,
            settledAt,
        })
        .where(
            and(
                effectIdentityWhere(input.effect),
                eq(desktopApprovalEffects.state, 'executing'),
                eq(desktopApprovalEffects.executionToken, input.executionToken),
                gt(desktopApprovalEffects.leaseExpiresAt, settledAt),
            ),
        );
    return result.rowsAffected === 1;
}

export async function resolveSqliteDesktopApprovalEffect(
    client: Client,
    sessionId: string,
    input: DesktopApprovalEffectResolutionInput,
): Promise<DesktopApprovalEffectRecord | undefined> {
    const db = drizzleFromClient(client);
    await db
        .update(desktopApprovalEffects)
        .set({
            outcome: input.outcome,
            resolvedAt: input.resolvedAt,
        })
        .where(
            and(
                eq(desktopApprovalEffects.sessionId, sessionId),
                eq(desktopApprovalEffects.approvalId, input.approvalId),
                eq(desktopApprovalEffects.state, 'unknown'),
                isNull(desktopApprovalEffects.outcome),
                isNull(desktopApprovalEffects.resolvedAt),
            ),
        );
    const record = await readSqliteDesktopApprovalEffect(client, sessionId, input.approvalId);
    if (record?.state !== 'unknown' || record.outcome !== input.outcome) return undefined;
    return record;
}

export async function recoverExpiredSqliteDesktopApprovalEffects(client: Client, now: string): Promise<number> {
    const db = drizzleFromClient(client);
    const result = await db
        .update(desktopApprovalEffects)
        .set({
            state: 'unknown',
            unknownAt: now,
        })
        .where(and(eq(desktopApprovalEffects.state, 'executing'), lte(desktopApprovalEffects.leaseExpiresAt, now)));
    return result.rowsAffected;
}

async function claimPendingEffect(
    client: Client,
    input: DesktopApprovalEffectClaimInput,
    now: string,
): Promise<DesktopApprovalEffectClaimResult> {
    if (input.leaseExpiresAt <= now) {
        throw new TypeError('desktop approval effect execution lease must expire after the claim time');
    }
    const db = drizzleFromClient(client);
    const result = await db
        .update(desktopApprovalEffects)
        .set({
            state: 'executing',
            executionToken: input.executionToken,
            leaseExpiresAt: input.leaseExpiresAt,
            executingAt: now,
        })
        .where(and(effectIdentityWhere(input.effect), eq(desktopApprovalEffects.state, 'pending')));
    if (result.rowsAffected !== 1) return claimResultAfterLostTransition(client, input.effect);
    return { status: 'claimed', record: await requireExecutingRecord(client, input.effect) };
}

async function recoverExpiredClaim(
    client: Client,
    input: DesktopApprovalEffectClaimInput,
    existing: DesktopApprovalEffectExecutingRecord,
    now: string,
): Promise<DesktopApprovalEffectClaimResult> {
    const db = drizzleFromClient(client);
    await db
        .update(desktopApprovalEffects)
        .set({
            state: 'unknown',
            unknownAt: now,
        })
        .where(
            and(
                effectIdentityWhere(input.effect),
                eq(desktopApprovalEffects.state, 'executing'),
                eq(desktopApprovalEffects.executionToken, existing.executionToken),
                eq(desktopApprovalEffects.leaseExpiresAt, existing.leaseExpiresAt),
                lte(desktopApprovalEffects.leaseExpiresAt, now),
            ),
        );
    return claimResultAfterLostTransition(client, input.effect);
}

async function claimResultAfterLostTransition(
    client: Client,
    effect: DesktopApprovalEffect,
): Promise<DesktopApprovalEffectClaimResult> {
    const record = await readSqliteDesktopApprovalEffect(client, effect.sessionId, effect.approvalId);
    if (record === undefined) return { status: 'missing' };
    if (!sameDesktopApprovalEffect(record.effect, effect)) return { status: 'identity_mismatch' };
    switch (record.state) {
        case 'executing':
            return { status: 'executing', record };
        case 'settled':
            return { status: 'settled', record };
        case 'unknown':
            return { status: 'unknown', record };
        case 'pending':
            throw new TypeError('pending desktop approval effect claim did not transition');
        default:
            return assertNeverEffectRecord(record);
    }
}

async function requireExecutingRecord(
    client: Client,
    effect: DesktopApprovalEffect,
): Promise<DesktopApprovalEffectExecutingRecord> {
    const record = await readSqliteDesktopApprovalEffect(client, effect.sessionId, effect.approvalId);
    if (record?.state !== 'executing') throw new TypeError('claimed desktop approval effect is not executing');
    return record;
}

function effectIdentityWhere(effect: DesktopApprovalEffect) {
    return and(
        eq(desktopApprovalEffects.sessionId, effect.sessionId),
        eq(desktopApprovalEffects.approvalId, effect.approvalId),
        eq(desktopApprovalEffects.runId, effect.runId),
        eq(desktopApprovalEffects.toolCallId, effect.toolCallId),
        eq(desktopApprovalEffects.toolName, effect.toolName),
        eq(desktopApprovalEffects.argumentsJson, effect.argumentsJson),
        eq(desktopApprovalEffects.workspaceRoot, effect.workspaceRoot),
    );
}

function assertNeverEffectRecord(record: never): never {
    throw new TypeError(`Unexpected desktop approval effect record: ${JSON.stringify(record)}`);
}
