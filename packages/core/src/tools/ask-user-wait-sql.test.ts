import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteSessionProjectionStoreForTests } from '../memory/sqlite-session-projection-test-support';
import {
    createSqlAskUserUserInputWaitMirror,
    resolveAskUserInputWait,
    startAskUserInputWait,
    waitIdForAskUserToolCall,
} from './ask-user-wait-sql';
import { createAskUserToolRegistration } from './ask-user-tool';
import type { ToolExecutionContext } from './tool-registry-types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDbUrl(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mctrl-ask-user-wait-'));
    tempDirs.push(dir);
    return `file:${join(dir, 'session.sqlite')}`;
}

function createContext(toolCallId = 'call-ask-1'): ToolExecutionContext {
    return {
        toolCallId,
        toolName: 'ask_user',
        signal: new AbortController().signal,
    };
}

describe('ask_user SQL user_input wait', () => {
    it('marks the public session awaiting/user_input while interactive ask_user is pending', async () => {
        // Given
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        try {
            const sessionId = 'session-ask-user';
            const context = createContext('call-pending');
            let releaseAnswer: ((value: string) => void) | undefined;
            const pendingAnswer = new Promise<string>((resolve) => {
                releaseAnswer = resolve;
            });
            let markStarted: () => void = () => undefined;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            const baseMirror = createSqlAskUserUserInputWaitMirror({ client, sessionId });
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => pendingAnswer,
                userInputWait: {
                    start: async (waitContext) => {
                        await baseMirror.start(waitContext);
                        markStarted();
                    },
                    resolve: (waitContext) => baseMirror.resolve(waitContext),
                },
            });

            // When: tool is waiting on the host
            const executePromise = registration.execute({ question: 'Continue?', options: ['yes'] }, context);
            await started;
            const whilePending = await publicStore.getSession(sessionId);

            // Then
            expect(whilePending).toMatchObject({
                sessionId,
                status: 'awaiting',
                awaiting: {
                    reason: 'user_input',
                    source: { toolCallId: context.toolCallId },
                },
            });

            // When: host answers
            releaseAnswer?.('yes');
            await executePromise;
            const afterAnswer = await publicStore.getSession(sessionId);

            // Then: wait cleared
            expect(afterAnswer?.status).not.toBe('awaiting');
            expect(afterAnswer?.awaiting).toBeUndefined();
        } finally {
            publicStore.close();
            client.close();
        }
    });

    it('clears the durable user_input wait when the host callback rejects', async () => {
        // Given
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        try {
            const sessionId = 'session-ask-reject';
            const context = createContext('call-reject');
            const registration = createAskUserToolRegistration({
                requestUserQuestion: async () => {
                    throw new Error('overlay dismissed');
                },
                userInputWait: createSqlAskUserUserInputWaitMirror({ client, sessionId }),
            });

            // When
            await expect(registration.execute({ question: 'Abort?', options: [] }, context)).rejects.toThrow(
                'overlay dismissed',
            );
            const afterReject = await publicStore.getSession(sessionId);

            // Then
            expect(afterReject?.status).not.toBe('awaiting');
            expect(afterReject?.awaiting).toBeUndefined();
        } finally {
            publicStore.close();
            client.close();
        }
    });

    it('does not leave a pending user_input wait for non-interactive sentinel execution', async () => {
        // Given
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        try {
            const sessionId = 'session-ask-noninteractive';
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => {
                    throw new Error('must not call host in nonInteractive mode');
                },
                nonInteractive: true,
                userInputWait: createSqlAskUserUserInputWaitMirror({ client, sessionId }),
            });

            // When
            await registration.execute({ question: 'Blocked?', options: [] }, createContext('call-ni'));
            const session = await publicStore.getSession(sessionId);
            const pending = await client.execute({
                sql: 'SELECT COUNT(*) AS count FROM session_awaits WHERE session_id = ? AND status = ? AND reason = ?',
                args: [sessionId, 'pending', 'user_input'],
            });

            // Then
            expect(session == null).toBe(true);
            expect(Number(pending.rows[0]?.['count'] ?? -1)).toBe(0);
        } finally {
            publicStore.close();
            client.close();
        }
    });

    it('start/resolve helpers write and clear a tool_call-sourced user_input wait row', async () => {
        // Given
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        try {
            const sessionId = 'session-helpers';
            const toolCallId = 'call-helpers';
            const now = '2026-07-20T00:00:00.000Z';

            // When
            await startAskUserInputWait({ client, sessionId, toolCallId, now });
            const waiting = await publicStore.getSession(sessionId);
            await resolveAskUserInputWait({ client, sessionId, toolCallId, now: '2026-07-20T00:00:01.000Z' });
            const cleared = await publicStore.getSession(sessionId);

            // Then
            expect(waitIdForAskUserToolCall(toolCallId)).toBe(`ask_user_wait_${toolCallId}`);
            expect(waiting).toMatchObject({
                status: 'awaiting',
                awaiting: { reason: 'user_input', source: { toolCallId } },
            });
            expect(cleared?.awaiting).toBeUndefined();
        } finally {
            publicStore.close();
            client.close();
        }
    });
});
