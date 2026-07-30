import type { Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import { desktopApprovalEffects } from '../db/schema';
import {
    DESKTOP_APPROVAL_EFFECT_OUTCOMES,
    type DesktopApprovalEffect,
    type DesktopApprovalEffectExecutingRecord,
    type DesktopApprovalEffectRecord,
} from '../desktop-approval-effect';

const identityRowSchema = z.object({
    sessionId: z.string(),
    approvalId: z.string(),
    runId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    argumentsJson: z.string(),
    workspaceRoot: z.string(),
    requestedAt: z.string(),
});

const pendingRowSchema = identityRowSchema.extend({
    state: z.literal('pending'),
    executionToken: z.null(),
    leaseExpiresAt: z.null(),
    outcome: z.null(),
    executingAt: z.null(),
    settledAt: z.null(),
    unknownAt: z.null(),
    resolvedAt: z.null(),
});

const executionFields = {
    executionToken: z.string(),
    leaseExpiresAt: z.string(),
    executingAt: z.string(),
} as const;

const executingRowSchema = identityRowSchema.extend({
    state: z.literal('executing'),
    ...executionFields,
    outcome: z.null(),
    settledAt: z.null(),
    unknownAt: z.null(),
    resolvedAt: z.null(),
});

const settledRowSchema = identityRowSchema.extend({
    state: z.literal('settled'),
    ...executionFields,
    outcome: z.enum(DESKTOP_APPROVAL_EFFECT_OUTCOMES),
    settledAt: z.string(),
    unknownAt: z.null(),
    resolvedAt: z.null(),
});

const unresolvedUnknownRowSchema = identityRowSchema.extend({
    state: z.literal('unknown'),
    ...executionFields,
    outcome: z.null(),
    settledAt: z.null(),
    unknownAt: z.string(),
    resolvedAt: z.null(),
});

const resolvedUnknownRowSchema = unresolvedUnknownRowSchema.extend({
    outcome: z.enum(DESKTOP_APPROVAL_EFFECT_OUTCOMES),
    resolvedAt: z.string(),
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

export async function readSqliteDesktopApprovalEffect(
    client: Client,
    sessionId: string,
    approvalId: string,
): Promise<DesktopApprovalEffectRecord | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({
            sessionId: desktopApprovalEffects.sessionId,
            approvalId: desktopApprovalEffects.approvalId,
            runId: desktopApprovalEffects.runId,
            toolCallId: desktopApprovalEffects.toolCallId,
            toolName: desktopApprovalEffects.toolName,
            argumentsJson: desktopApprovalEffects.argumentsJson,
            workspaceRoot: desktopApprovalEffects.workspaceRoot,
            state: desktopApprovalEffects.state,
            executionToken: desktopApprovalEffects.executionToken,
            leaseExpiresAt: desktopApprovalEffects.leaseExpiresAt,
            outcome: desktopApprovalEffects.outcome,
            requestedAt: desktopApprovalEffects.requestedAt,
            executingAt: desktopApprovalEffects.executingAt,
            settledAt: desktopApprovalEffects.settledAt,
            unknownAt: desktopApprovalEffects.unknownAt,
            resolvedAt: desktopApprovalEffects.resolvedAt,
        })
        .from(desktopApprovalEffects)
        .where(
            and(eq(desktopApprovalEffects.sessionId, sessionId), eq(desktopApprovalEffects.approvalId, approvalId)),
        );
    const row = rows[0];
    return row === undefined ? undefined : effectRecordFromRow(effectRowSchema.parse(row));
}

function effectRecordFromRow(row: EffectRow): DesktopApprovalEffectRecord {
    const effect = effectFromRow(row);
    switch (row.state) {
        case 'pending':
            return { effect, state: 'pending', requestedAt: row.requestedAt };
        case 'executing':
            return executionRecordFromRow(effect, row);
        case 'settled':
            return {
                ...executionRecordFromRow(effect, row),
                state: 'settled',
                outcome: row.outcome,
                settledAt: row.settledAt,
            };
        case 'unknown': {
            const execution = executionRecordFromRow(effect, row);
            return row.outcome === null
                ? { ...execution, state: 'unknown', unknownAt: row.unknownAt }
                : {
                      ...execution,
                      state: 'unknown',
                      unknownAt: row.unknownAt,
                      outcome: row.outcome,
                      resolvedAt: row.resolvedAt,
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
        executionToken: row.executionToken,
        leaseExpiresAt: row.leaseExpiresAt,
        requestedAt: row.requestedAt,
        executingAt: row.executingAt,
    };
}

function effectFromRow(row: z.infer<typeof identityRowSchema>): DesktopApprovalEffect {
    return {
        sessionId: row.sessionId,
        approvalId: row.approvalId,
        runId: row.runId,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        argumentsJson: row.argumentsJson,
        workspaceRoot: row.workspaceRoot,
    };
}

function assertNeverRow(row: never): never {
    throw new TypeError(`Unexpected desktop approval effect row: ${JSON.stringify(row)}`);
}
