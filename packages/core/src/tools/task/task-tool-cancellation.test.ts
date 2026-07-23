import { describe, expect, it } from 'vitest';
import type { SessionControlEpoch } from '../../runtime/session-control-cancellation';
import { ToolRegistry } from '../tool-registry';
import type { ToolExecutionContext } from '../tool-registry-types';
import {
    type ChildSpawnRequest,
    createFullParityTaskToolRegistration,
    type TaskToolRuntime,
    taskToolInputSchema,
} from './task-tool';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'c'.repeat(64),
    sessionId: 'session-task-parent',
    ownerId: 'owner-task-parent',
    ownerEpoch: 11,
};

describe('full-parity task cancellation propagation', () => {
    it('forwards tool signal and owner epoch into the child request', async () => {
        let captured: ChildSpawnRequest | undefined;
        const runtime: TaskToolRuntime = {
            runChildSession: (request) => {
                captured = request;
                return Promise.resolve({ sessionId: request.sessionId, status: 'completed', output: 'done' });
            },
            startBackgroundSession: () => ({ sessionId: 'unused', backgroundId: 'unused' }),
            resumeChildSession: (sessionId) => Promise.resolve({ sessionId, status: 'completed', output: 'done' }),
            sessionExists: () => false,
            generateSessionId: () => 'session-task-child',
        };
        const registration = createFullParityTaskToolRegistration({ runtime });
        const controller = new AbortController();
        const context: ToolExecutionContext = {
            toolCallId: 'task-call',
            toolName: 'task',
            signal: controller.signal,
            controlEpoch: CONTROL_EPOCH,
        };

        await registration.execute(
            taskToolInputSchema.parse({ prompt: 'work', subagent_type: 'deep', load_skills: [] }),
            context,
        );

        expect(captured?.signal).toBe(controller.signal);
        expect(captured?.controlEpoch).toEqual(CONTROL_EPOCH);
    });

    it('settles an explicitly aborted child result as tool.failed', async () => {
        const runtime: TaskToolRuntime = {
            runChildSession: (request) =>
                Promise.resolve({
                    sessionId: request.sessionId,
                    status: 'failed',
                    output: 'cancelled',
                    failureKind: 'aborted',
                }),
            startBackgroundSession: () => ({ sessionId: 'unused', backgroundId: 'unused' }),
            resumeChildSession: (sessionId) => Promise.resolve({ sessionId, status: 'failed', output: 'cancelled' }),
            sessionExists: () => false,
            generateSessionId: () => 'session-task-cancelled',
        };
        const registry = new ToolRegistry();
        const advertisement = registry.register(createFullParityTaskToolRegistration({ runtime }));
        const controller = new AbortController();

        const settlement = await registry.invoke({
            toolCallId: 'task-cancelled',
            toolName: 'task',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ prompt: 'work', subagent_type: 'deep', load_skills: [] }),
            signal: controller.signal,
        });

        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'operator_aborted', retryable: false },
        });
        expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
    });

    it('keeps a yield-missing result retryable after the parent signal aborts', async () => {
        const runtime: TaskToolRuntime = {
            runChildSession: (request) =>
                Promise.resolve({
                    sessionId: request.sessionId,
                    status: 'failed',
                    output: '[degraded salvage] completed investigation',
                    failureKind: 'yield_missing',
                }),
            startBackgroundSession: () => ({ sessionId: 'unused', backgroundId: 'unused' }),
            resumeChildSession: (sessionId) => Promise.resolve({ sessionId, status: 'failed', output: 'cancelled' }),
            sessionExists: () => false,
            generateSessionId: () => 'session-task-yield-missing',
        };
        const registry = new ToolRegistry();
        const advertisement = registry.register(createFullParityTaskToolRegistration({ runtime }));
        const controller = new AbortController();
        controller.abort();

        const settlement = await registry.invoke({
            toolCallId: 'task-yield-missing',
            toolName: 'task',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ prompt: 'work', subagent_type: 'deep', load_skills: [] }),
            signal: controller.signal,
        });

        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'task_yield_missing', retryable: true },
        });
    });
});
