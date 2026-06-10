import type {
    NativeSidecarStatus,
    SidecarCapability,
    SidecarTaskInput,
    SidecarTaskOutput,
} from '@mission-control/protocol';
import type { SidecarClient } from './sidecar-client.js';

export class MockSidecarClient implements SidecarClient {
    status(): NativeSidecarStatus {
        return 'mock';
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

    async runTask(input: SidecarTaskInput): Promise<SidecarTaskOutput> {
        return Promise.resolve({
            id: input.id,
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });
    }
}
