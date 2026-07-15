import type { Client } from '@libsql/client';
import { type ToolCall, ToolCallSchema } from '@mission-control/protocol';
import { z } from 'zod';

const DesktopToolProposalRowSchema = z.object({
    tool_call_id: z.string(),
    tool_name: z.string(),
    arguments_json: z.string(),
});

export async function recordSqliteDesktopToolProposals(
    client: Client,
    sessionId: string,
    toolCalls: readonly ToolCall[],
    createdAt: string,
): Promise<void> {
    for (const toolCall of toolCalls) {
        await client.execute({
            sql:
                'INSERT INTO desktop_tool_proposals ' +
                '(session_id,tool_call_id,tool_name,arguments_json,created_at,conflicted) VALUES (?,?,?,?,?,0) ' +
                'ON CONFLICT(session_id,tool_call_id) DO UPDATE SET conflicted = CASE ' +
                'WHEN desktop_tool_proposals.tool_name <> excluded.tool_name ' +
                'OR desktop_tool_proposals.arguments_json <> excluded.arguments_json THEN 1 ' +
                'ELSE desktop_tool_proposals.conflicted END',
            args: [sessionId, toolCall.toolCallId, toolCall.toolName, toolCall.argumentsJson, createdAt],
        });
    }
}

export async function readSqliteDesktopToolProposal(
    client: Client,
    sessionId: string,
    toolCallId: string,
): Promise<ToolCall | undefined> {
    const result = await client.execute({
        sql:
            'SELECT tool_call_id,tool_name,arguments_json FROM desktop_tool_proposals ' +
            'WHERE session_id = ? AND tool_call_id = ? AND conflicted = 0',
        args: [sessionId, toolCallId],
    });
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const parsed = DesktopToolProposalRowSchema.parse(row);
    return ToolCallSchema.parse({
        toolCallId: parsed.tool_call_id,
        toolName: parsed.tool_name,
        argumentsJson: parsed.arguments_json,
    });
}
