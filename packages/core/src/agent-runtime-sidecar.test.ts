import type { AgentEvent, NativeSidecarStatus, SidecarCapability, SidecarTaskInput } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { runTaskWithSidecarFallback } from './agent-runtime-sidecar.js';
import type { SidecarClient } from './native/sidecar-client.js';

describe('runTaskWithSidecarFallback sidecar status', () => {
    it('emits native status and negotiated capabilities when a native sidecar task succeeds', async () => {
        // Given
        const events: AgentEvent[] = [];
        const client = new SuccessfulNativeSidecarClient();

        // When
        const output = await runTaskWithSidecarFallback({
            taskId: 'task_native',
            sessionId: 'session_native',
            sidecarClient: client,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
            emit: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toEqual({
            id: 'task_native',
            message: 'completed by rust sidecar',
            nativeSidecarStatus: 'native',
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'native.status',
                sessionId: 'session_native',
                taskId: 'task_native',
                nativeSidecarStatus: 'native',
                message: 'sidecar status: native; capabilities: task.run',
            }),
        );
    });
});

class SuccessfulNativeSidecarClient implements SidecarClient {
    status(): NativeSidecarStatus {
        return 'native';
    }

    capabilities(): readonly SidecarCapability[] {
        return ['task.run'];
    }

    async start(): Promise<void> {
        return Promise.resolve();
    }

    async stop(): Promise<void> {
        return Promise.resolve();
    }

    async runTask(input: SidecarTaskInput) {
        return Promise.resolve({
            id: input.id,
            message: 'completed by rust sidecar',
            nativeSidecarStatus: 'native' as const,
        });
    }
}
