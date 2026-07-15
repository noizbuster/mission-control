import type { Client } from '@libsql/client';
import { z } from 'zod';
import {
    DESKTOP_APPROVAL_EFFECT_OUTCOMES,
    type DesktopApprovalEffect,
    type DesktopApprovalEffectExecutingRecord,
    type DesktopApprovalEffectRecord,
} from '../desktop-approval-effect.js';

const identityRowSchema = z.object({
    session_id: z.string(),
    approval_id: z.string(),
    run_id: z.string(),
    tool_call_id: z.string(),
    tool_name: z.string(),
    arguments_json: z.string(),
    workspace_root: z.string(),
    requested_at: z.string(),
});

const pendingRowSchema = identityRowSchema.extend({
    state: z.literal('pending'),
    execution_token: z.null(),
    lease_expires_at: z.null(),
    outcome: z.null(),
    executing_at: z.null(),
    settled_at: z.null(),
    unknown_at: z.null(),
    resolved_at: z.null(),
});

const executionFields = {
    execution_token: z.string(),
    lease_expires_at: z.string(),
    executing_at: z.string(),
} as const;

const executingRowSchema = identityRowSchema.extend({
    state: z.literal('executing'),
    ...executionFields,
    outcome: z.null(),
    settled_at: z.null(),
    unknown_at: z.null(),
    resolved_at: z.null(),
});

const settledRowSchema = identityRowSchema.extend({
    state: z.literal('settled'),
    ...executionFields,
    outcome: z.enum(DESKTOP_APPROVAL_EFFECT_OUTCOMES),
    settled_at: z.string(),
    unknown_at: z.null(),
    resolved_at: z.null(),
});

const unresolvedUnknownRowSchema = identityRowSchema.extend({
    state: z.literal('unknown'),
    ...executionFields,
    outcome: z.null(),
    settled_at: z.null(),
    unknown_at: z.string(),
    resolved_at: z.null(),
});

const resolvedUnknownRowSchema = unresolvedUnknownRowSchema.extend({
    outcome: z.enum(DESKTOP_APPROVAL_EFFECT_OUTCOMES),
    resolved_at: z.string(),
});

const effectRowSchema = z.union([
    pendingRowSchema,
    executingRowSchema,
    settledRowSchema,
    unresolvedUnknownRowSchema,
    resolvedUnknownRowSchema,
]);
type EffectRow = z.infer<typeof effectRowSchema>;
type ExecutionRow = Exclude<EffectRow, z.infer<typeof pendingRowSchema>>;

const selectEffectSql =
    'SELECT session_id,approval_id,run_id,tool_call_id,tool_name,arguments_json,workspace_root,state,' +
    'execution_token,lease_expires_at,outcome,requested_at,executing_at,settled_at,unknown_at,resolved_at ' +
    'FROM desktop_approval_effects WHERE session_id = ? AND approval_id = ?';

export async function readSqliteDesktopApprovalEffect(
    client: Client,
    sessionId: string,
    approvalId: string,
): Promise<DesktopApprovalEffectRecord | undefined> {
    const result = await client.execute({ sql: selectEffectSql, args: [sessionId, approvalId] });
    const row = result.rows[0];
    return row === undefined ? undefined : effectRecordFromRow(effectRowSchema.parse(row));
}

function effectRecordFromRow(row: EffectRow): DesktopApprovalEffectRecord {
    const effect = effectFromRow(row);
    switch (row.state) {
        case 'pending':
            return { effect, state: 'pending', requestedAt: row.requested_at };
        case 'executing':
            return executionRecordFromRow(effect, row);
        case 'settled':
            return {
                ...executionRecordFromRow(effect, row),
                state: 'settled',
                outcome: row.outcome,
                settledAt: row.settled_at,
            };
        case 'unknown': {
            const execution = executionRecordFromRow(effect, row);
            return row.outcome === null
                ? { ...execution, state: 'unknown', unknownAt: row.unknown_at }
                : {
                      ...execution,
                      state: 'unknown',
                      unknownAt: row.unknown_at,
                      outcome: row.outcome,
                      resolvedAt: row.resolved_at,
                  };
        }
        default:
            return assertNeverRow(row);
    }
}

function executionRecordFromRow(
    effect: DesktopApprovalEffect,
    row: ExecutionRow,
): DesktopApprovalEffectExecutingRecord {
    return {
        effect,
        state: 'executing',
        executionToken: row.execution_token,
        leaseExpiresAt: row.lease_expires_at,
        requestedAt: row.requested_at,
        executingAt: row.executing_at,
    };
}

function effectFromRow(row: z.infer<typeof identityRowSchema>): DesktopApprovalEffect {
    return {
        sessionId: row.session_id,
        approvalId: row.approval_id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        argumentsJson: row.arguments_json,
        workspaceRoot: row.workspace_root,
    };
}

function assertNeverRow(row: never): never {
    throw new TypeError(`Unexpected desktop approval effect row: ${JSON.stringify(row)}`);
}
