import type { Client } from '@libsql/client';
import type { TaskToolSubagentMirror } from '../agents/task-tool-runtime-types';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql';
import type { AskUserUserInputWaitMirror } from './ask-user-schemas';

export function waitIdForAskUserToolCall(toolCallId: string): string {
    return `ask_user_wait_${toolCallId}`;
}

export function createAskUserWaitMirrorFromTaskMirror(input: {
    readonly sessionId: string;
    readonly mirror: TaskToolSubagentMirror | undefined;
}): AskUserUserInputWaitMirror | undefined {
    const startUserInputWait = input.mirror?.startUserInputWait;
    const resolveUserInputWait = input.mirror?.resolveUserInputWait;
    if (input.mirror === undefined || startUserInputWait === undefined || resolveUserInputWait === undefined) {
        return undefined;
    }
    const mirror = input.mirror;
    const sessionId = input.sessionId;
    return {
        start: ({ toolCallId }) => startUserInputWait.call(mirror, { sessionId, toolCallId }),
        resolve: ({ toolCallId }) => resolveUserInputWait.call(mirror, { sessionId, toolCallId }),
    };
}

export type AskUserInputWaitSqlInput = {
    readonly client: Client;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly now?: string;
};

export async function startAskUserInputWait(input: AskUserInputWaitSqlInput): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    const waitId = waitIdForAskUserToolCall(input.toolCallId);
    await ensurePublicSessionRow({ client: input.client, sessionId: input.sessionId, now });
    await input.client.execute({
        sql:
            'INSERT INTO session_awaits ' +
            '(wait_id, session_id, reason, source_kind, source_id, tool_call_id, status, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(wait_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at, ' +
            'resolved_at = NULL, cancelled_at = NULL, tool_call_id = excluded.tool_call_id, ' +
            'source_kind = excluded.source_kind, source_id = excluded.source_id',
        args: [waitId, input.sessionId, 'user_input', 'tool_call', input.toolCallId, input.toolCallId, 'pending', now],
    });
    await persistSessionAwaiting({
        client: input.client,
        sessionId: input.sessionId,
        reason: 'user_input',
        waitId,
        now,
    });
}

export async function resolveAskUserInputWait(input: AskUserInputWaitSqlInput): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    const waitId = waitIdForAskUserToolCall(input.toolCallId);
    await ensurePublicSessionRow({ client: input.client, sessionId: input.sessionId, now });
    await input.client.execute({
        sql: 'UPDATE session_awaits SET status = ?, resolved_at = ? WHERE wait_id = ? AND session_id = ? AND status = ?',
        args: ['resolved', now, waitId, input.sessionId, 'pending'],
    });
    await refreshSessionAwaitingFromPendingWaits({
        client: input.client,
        sessionId: input.sessionId,
        now,
    });
}

export function createSqlAskUserUserInputWaitMirror(input: {
    readonly client: Client;
    readonly sessionId: string;
}): AskUserUserInputWaitMirror {
    return {
        start: ({ toolCallId }) => startAskUserInputWait({ client: input.client, sessionId: input.sessionId, toolCallId }),
        resolve: ({ toolCallId }) =>
            resolveAskUserInputWait({ client: input.client, sessionId: input.sessionId, toolCallId }),
    };
}
