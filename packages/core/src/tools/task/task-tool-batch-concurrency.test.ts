import { describe, expect, it } from 'vitest';
import type { ToolExecutionContext } from '../tool-registry-types';
import { createFullParityTaskToolRegistration, type TaskToolRuntime, taskToolInputSchema } from './task-tool';

const context: ToolExecutionContext = {
    toolCallId: 'tc_batch_concurrency',
    toolName: 'task',
    signal: new AbortController().signal,
};

describe('task tool foreground batch concurrency', () => {
    it('limits foreground batch execution to four children at a time', async () => {
        let active = 0;
        let maximumActive = 0;
        let runCount = 0;
        let releaseChildren: (() => void) | undefined;
        const release = new Promise<void>((resolve) => {
            releaseChildren = resolve;
        });
        let resolveFourStarted: (() => void) | undefined;
        const fourStarted = new Promise<void>((resolve) => {
            resolveFourStarted = resolve;
        });
        const runtime: TaskToolRuntime = {
            runChildSession: async (request) => {
                runCount += 1;
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                if (active === 4) resolveFourStarted?.();
                await release;
                active -= 1;
                return { sessionId: request.sessionId, status: 'completed', output: 'ok' };
            },
            startBackgroundSession: (request) => ({ sessionId: request.sessionId, backgroundId: 'bg_test' }),
            resumeChildSession: async (sessionId) => ({ sessionId, status: 'completed', output: 'ok' }),
            sessionExists: () => false,
            generateSessionId: () => `session_${runCount + 1}`,
        };
        const tool = createFullParityTaskToolRegistration({ runtime });

        const run = tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                tasks: Array.from({ length: 6 }, (_, index) => ({
                    agent: 'explore',
                    assignment: `work-${index + 1}`,
                })),
            }),
            context,
        );
        await fourStarted;
        expect(maximumActive).toBe(4);
        releaseChildren?.();
        const result = await run;

        expect(runCount).toBe(6);
        expect(result.batch).toHaveLength(6);
    });
});
