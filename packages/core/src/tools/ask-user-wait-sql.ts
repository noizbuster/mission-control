import type { Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import type { TaskToolSubagentMirror } from '../agents/task-tool-runtime-types';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessionAwaits } from '../db/schema';
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
    const db = drizzleFromClient(input.client);
    await db
        .insert(sessionAwaits)
        .values({
            waitId,
            sessionId: input.sessionId,
            reason: 'user_input',
            sourceKind: 'tool_call',
            sourceId: input.toolCallId,
            toolCallId: input.toolCallId,
            status: 'pending',
            createdAt: now,
        })
        .onConflictDoUpdate({
            target: sessionAwaits.waitId,
            set: {
                status: 'pending',
                createdAt: now,
                resolvedAt: null,
                cancelledAt: null,
                toolCallId: input.toolCallId,
                sourceKind: 'tool_call',
                sourceId: input.toolCallId,
            },
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
    const db = drizzleFromClient(input.client);
    await db
        .update(sessionAwaits)
        .set({
            status: 'resolved',
            resolvedAt: now,
        })
        .where(
            and(
                eq(sessionAwaits.waitId, waitId),
                eq(sessionAwaits.sessionId, input.sessionId),
                eq(sessionAwaits.status, 'pending'),
            ),
        );
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
        start: ({ toolCallId }) =>
            startAskUserInputWait({ client: input.client, sessionId: input.sessionId, toolCallId }),
        resolve: ({ toolCallId }) =>
            resolveAskUserInputWait({ client: input.client, sessionId: input.sessionId, toolCallId }),
    };
}
