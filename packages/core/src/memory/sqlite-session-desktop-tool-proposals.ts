import type { Client } from '@libsql/client';
import { type ToolCall, ToolCallSchema } from '@mission-control/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import { desktopToolProposals } from '../db/schema';

const DesktopToolProposalRowSchema = z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    argumentsJson: z.string(),
});

export async function recordSqliteDesktopToolProposals(
    client: Client,
    sessionId: string,
    toolCalls: readonly ToolCall[],
    createdAt: string,
): Promise<void> {
    const db = drizzleFromClient(client);
    for (const toolCall of toolCalls) {
        await db
            .insert(desktopToolProposals)
            .values({
                sessionId,
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                argumentsJson: toolCall.argumentsJson,
                createdAt,
                conflicted: 0,
            })
            .onConflictDoUpdate({
                target: [desktopToolProposals.sessionId, desktopToolProposals.toolCallId],
                set: {
                    conflicted: sql`CASE WHEN ${desktopToolProposals.toolName} <> excluded.tool_name OR ${desktopToolProposals.argumentsJson} <> excluded.arguments_json THEN 1 ELSE ${desktopToolProposals.conflicted} END`,
                },
            });
    }
}

export async function readSqliteDesktopToolProposal(
    client: Client,
    sessionId: string,
    toolCallId: string,
): Promise<ToolCall | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({
            toolCallId: desktopToolProposals.toolCallId,
            toolName: desktopToolProposals.toolName,
            argumentsJson: desktopToolProposals.argumentsJson,
        })
        .from(desktopToolProposals)
        .where(
            and(
                eq(desktopToolProposals.sessionId, sessionId),
                eq(desktopToolProposals.toolCallId, toolCallId),
                eq(desktopToolProposals.conflicted, 0),
            ),
        );
    const row = rows[0];
    if (row === undefined) return undefined;
    const parsed = DesktopToolProposalRowSchema.parse(row);
    return ToolCallSchema.parse({
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        argumentsJson: parsed.argumentsJson,
    });
}
