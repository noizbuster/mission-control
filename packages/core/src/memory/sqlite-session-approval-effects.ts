import type { Client } from '@libsql/client';
import type {
    DesktopApprovalEffect,
    DesktopApprovalEffectClaimInput,
    DesktopApprovalEffectClaimResult,
    DesktopApprovalEffectExecutingRecord,
    DesktopApprovalEffectRecord,
    DesktopApprovalEffectResolutionInput,
    DesktopApprovalEffectSettlementInput,
} from '../desktop-approval-effect.js';
import { sameDesktopApprovalEffect } from '../desktop-approval-effect.js';
import { readSqliteDesktopApprovalEffect } from './sqlite-session-approval-effect-records.js';

export { readSqliteDesktopApprovalEffect } from './sqlite-session-approval-effect-records.js';

export async function reserveSqliteDesktopApprovalEffect(
    client: Client,
    effect: DesktopApprovalEffect,
    requestedAt: string,
): Promise<boolean> {
    const inserted = await client.execute({
        sql:
            'INSERT OR IGNORE INTO desktop_approval_effects ' +
            '(session_id,approval_id,run_id,tool_call_id,tool_name,arguments_json,workspace_root,state,requested_at) ' +
            'VALUES (?,?,?,?,?,?,?,?,?)',
        args: [...effectArgs(effect), 'pending', requestedAt],
    });
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
    const result = await client.execute({
        sql:
            'UPDATE desktop_approval_effects SET state = ?, outcome = ?, settled_at = ? ' +
            'WHERE session_id = ? AND approval_id = ? AND run_id = ? AND tool_call_id = ? ' +
            'AND tool_name = ? AND arguments_json = ? AND workspace_root = ? ' +
            'AND state = ? AND execution_token = ? AND lease_expires_at > ?',
        args: [
            'settled',
            input.outcome,
            settledAt,
            ...effectArgs(input.effect),
            'executing',
            input.executionToken,
            settledAt,
        ],
    });
    return result.rowsAffected === 1;
}

export async function resolveSqliteDesktopApprovalEffect(
    client: Client,
    sessionId: string,
    input: DesktopApprovalEffectResolutionInput,
): Promise<DesktopApprovalEffectRecord | undefined> {
    await client.execute({
        sql:
            'UPDATE desktop_approval_effects SET outcome = ?, resolved_at = ? ' +
            'WHERE session_id = ? AND approval_id = ? AND state = ? AND outcome IS NULL AND resolved_at IS NULL',
        args: [input.outcome, input.resolvedAt, sessionId, input.approvalId, 'unknown'],
    });
    const record = await readSqliteDesktopApprovalEffect(client, sessionId, input.approvalId);
    if (record?.state !== 'unknown' || record.outcome !== input.outcome) return undefined;
    return record;
}

export async function recoverExpiredSqliteDesktopApprovalEffects(client: Client, now: string): Promise<number> {
    const result = await client.execute({
        sql:
            'UPDATE desktop_approval_effects SET state = ?, unknown_at = ? ' +
            'WHERE state = ? AND lease_expires_at <= ?',
        args: ['unknown', now, 'executing', now],
    });
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
    const result = await client.execute({
        sql:
            'UPDATE desktop_approval_effects ' +
            'SET state = ?, execution_token = ?, lease_expires_at = ?, executing_at = ? ' +
            'WHERE session_id = ? AND approval_id = ? AND run_id = ? AND tool_call_id = ? ' +
            'AND tool_name = ? AND arguments_json = ? AND workspace_root = ? AND state = ?',
        args: ['executing', input.executionToken, input.leaseExpiresAt, now, ...effectArgs(input.effect), 'pending'],
    });
    if (result.rowsAffected !== 1) return claimResultAfterLostTransition(client, input.effect);
    return { status: 'claimed', record: await requireExecutingRecord(client, input.effect) };
}

async function recoverExpiredClaim(
    client: Client,
    input: DesktopApprovalEffectClaimInput,
    existing: DesktopApprovalEffectExecutingRecord,
    now: string,
): Promise<DesktopApprovalEffectClaimResult> {
    await client.execute({
        sql:
            'UPDATE desktop_approval_effects SET state = ?, unknown_at = ? ' +
            'WHERE session_id = ? AND approval_id = ? AND run_id = ? AND tool_call_id = ? ' +
            'AND tool_name = ? AND arguments_json = ? AND workspace_root = ? ' +
            'AND state = ? AND execution_token = ? AND lease_expires_at = ? AND lease_expires_at <= ?',
        args: [
            'unknown',
            now,
            ...effectArgs(input.effect),
            'executing',
            existing.executionToken,
            existing.leaseExpiresAt,
            now,
        ],
    });
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

function effectArgs(effect: DesktopApprovalEffect): readonly string[] {
    return [
        effect.sessionId,
        effect.approvalId,
        effect.runId,
        effect.toolCallId,
        effect.toolName,
        effect.argumentsJson,
        effect.workspaceRoot,
    ];
}

function assertNeverEffectRecord(record: never): never {
    throw new TypeError(`Unexpected desktop approval effect record: ${JSON.stringify(record)}`);
}
