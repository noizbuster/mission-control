import type {
    AgentEvent,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { runTaskWithSidecarFallback } from './agent-runtime-sidecar.js';
import type { SidecarClient } from './native/sidecar-client.js';

export type RuntimeDemoTaskInput = {
    readonly sessionId: string;
    readonly sidecarClient: SidecarClient;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly requestPermission: (request: PermissionRequest, taskId?: string) => Promise<PermissionDecision>;
    readonly emit: (event: AgentEvent) => void;
};

const demoTaskId = 'task_demo';

export async function runRuntimeDemoTask(input: RuntimeDemoTaskInput): Promise<void> {
    await input.requestPermission(
        {
            id: `permission_${demoTaskId}`,
            action: 'task.run',
            reason: 'demo task permission gate',
        },
        demoTaskId,
    );
    input.emit({
        type: 'task.started',
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId: demoTaskId,
        message: 'demo task started',
        nativeSidecarStatus: input.sidecarClient.status(),
        modelProviderSelection: input.modelProviderSelection,
    });
    input.emit({
        type: 'task.progress',
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId: demoTaskId,
        progress: 0.5,
        message: 'demo task in progress',
        nativeSidecarStatus: input.sidecarClient.status(),
        modelProviderSelection: input.modelProviderSelection,
    });
    const output = await runTaskWithSidecarFallback({
        taskId: demoTaskId,
        sessionId: input.sessionId,
        sidecarClient: input.sidecarClient,
        modelProviderSelection: input.modelProviderSelection,
        emit: input.emit,
    });
    input.emit({
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId: demoTaskId,
        message: output.message,
        nativeSidecarStatus: output.nativeSidecarStatus ?? input.sidecarClient.status(),
        modelProviderSelection: input.modelProviderSelection,
    });
}
