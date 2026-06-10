import type {
    AgentEvent,
    ModelProviderSelection,
    NativeSidecarStatus,
    SidecarTaskOutput,
} from '@mission-control/protocol';
import { MockSidecarClient } from './native/mock-sidecar-client.js';
import type { SidecarClient } from './native/sidecar-client.js';

const sidecarEnvKey = 'MISSION_CONTROL_SIDECAR';

export type RuntimeSidecarFallbackInput = {
    readonly taskId: string;
    readonly sessionId: string | undefined;
    readonly sidecarClient: SidecarClient;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly emit: (event: AgentEvent) => void;
};

export async function runTaskWithSidecarFallback(input: RuntimeSidecarFallbackInput): Promise<SidecarTaskOutput> {
    try {
        const output = await input.sidecarClient.runTask({
            id: input.taskId,
            payload: {
                label: 'demo',
            },
        });
        emitNativeStatus(input, output.nativeSidecarStatus ?? input.sidecarClient.status());
        return output;
    } catch (error: unknown) {
        input.emit({
            type: 'native.warning',
            timestamp: new Date().toISOString(),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            taskId: input.taskId,
            message: error instanceof Error ? error.message : String(error),
            nativeSidecarStatus: 'unavailable',
            modelProviderSelection: input.modelProviderSelection,
        });
        const mock = new MockSidecarClient();
        const output = await mock.runTask({
            id: input.taskId,
            payload: {
                label: 'demo',
            },
        });
        emitNativeStatus({ ...input, sidecarClient: mock }, 'mock');
        return output;
    }
}

export function resolveSidecarCommand(input: { readonly sidecarCommand?: string }): string {
    return input.sidecarCommand ?? process.env[sidecarEnvKey] ?? 'mission-control-sidecar';
}

function emitNativeStatus(input: RuntimeSidecarFallbackInput, status: NativeSidecarStatus): void {
    input.emit({
        type: 'native.status',
        timestamp: new Date().toISOString(),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        taskId: input.taskId,
        message: `sidecar status: ${status}; capabilities: ${input.sidecarClient.capabilities().join(', ')}`,
        nativeSidecarStatus: status,
        modelProviderSelection: input.modelProviderSelection,
    });
}
