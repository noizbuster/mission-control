import type { Client } from '@libsql/client';
import { z } from 'zod';
import { type DesktopApprovalEffect, sameDesktopApprovalEffect } from '../desktop-approval-effect.js';

const effectRowSchema = z.object({
    session_id: z.string(),
    approval_id: z.string(),
    run_id: z.string(),
    tool_call_id: z.string(),
    tool_name: z.string(),
    arguments_json: z.string(),
    workspace_root: z.string(),
    state: z.enum(['pending', 'settled']),
});

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

    const existing = await client.execute({
        sql:
            'SELECT session_id,approval_id,run_id,tool_call_id,tool_name,arguments_json,workspace_root,state ' +
            'FROM desktop_approval_effects WHERE session_id = ? AND approval_id = ?',
        args: [effect.sessionId, effect.approvalId],
    });
    const row = existing.rows[0];
    if (row === undefined) return false;
    const parsed = effectRowSchema.parse(row);
    return parsed.state === 'pending' && sameDesktopApprovalEffect(effectFromRow(parsed), effect);
}

export async function claimSqliteDesktopApprovalEffect(
    client: Client,
    effect: DesktopApprovalEffect,
    settledAt: string,
): Promise<boolean> {
    const result = await client.execute({
        sql:
            'UPDATE desktop_approval_effects SET state = ?, settled_at = ? ' +
            'WHERE session_id = ? AND approval_id = ? AND run_id = ? AND tool_call_id = ? ' +
            'AND tool_name = ? AND arguments_json = ? AND workspace_root = ? AND state = ?',
        args: ['settled', settledAt, ...effectArgs(effect), 'pending'],
    });
    return result.rowsAffected === 1;
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

function effectFromRow(row: z.infer<typeof effectRowSchema>): DesktopApprovalEffect {
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
