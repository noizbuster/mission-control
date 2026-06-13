import { defaultModelProviderSelection } from '@mission-control/config';
import type {
    AgentEvent,
    AgentEventEnvelope,
    AgentSession,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ProtocolErrorCode,
} from '@mission-control/protocol';
import type { AgentRuntimeOptions } from './agent-runtime-options.js';
import type { RuntimeApprovalBlockedError } from './agent-runtime-provider-turn.js';
import { runRuntimeProviderPromptTask } from './agent-runtime-provider-turn.js';
import { resolveSidecarCommand } from './agent-runtime-sidecar.js';
import { PermissionGate } from './approval-gate.js';
import { EventBus } from './event-bus.js';
import { MockSidecarClient } from './native/mock-sidecar-client.js';
import { ProcessSidecarClient, type SidecarClient } from './native/sidecar-client.js';
import { createDefaultPermissionDecision } from './permissions.js';
import { SessionEventLog } from './session-log.js';

export function createRuntimeSidecarClient(options: AgentRuntimeOptions): SidecarClient {
    return options.useNative
        ? new ProcessSidecarClient(resolveSidecarCommand(options), options.sidecarTimeoutMs, {
              ...(options.enableSidecarProtocolV2 !== undefined
                  ? { enableProtocolV2: options.enableSidecarProtocolV2 }
                  : {}),
          })
        : new MockSidecarClient();
}

export function createRuntimeApprovalGate(
    options: AgentRuntimeOptions,
    emit: (event: AgentEvent) => void,
): PermissionGate {
    return new PermissionGate({
        resolveDecision: options.permissionDecisionResolver ?? createDefaultPermissionDecision,
        emit,
        now: () => new Date().toISOString(),
        ...(options.pendingApprovalBehavior !== undefined
            ? { pendingApprovalBehavior: options.pendingApprovalBehavior }
            : {}),
    });
}

export function runtimeModelProviderSelection(options: AgentRuntimeOptions): ModelProviderSelection {
    return options.modelProviderSelection ?? defaultModelProviderSelection;
}

export function allocatePromptTaskId(promptTaskCounter: number): {
    readonly nextPromptTaskCounter: number;
    readonly taskId: string;
} {
    const nextPromptTaskCounter = promptTaskCounter + 1;
    return {
        nextPromptTaskCounter,
        taskId: `task_prompt_${nextPromptTaskCounter}`,
    };
}

export function emitRuntimeEnvelope(
    log: SessionEventLog,
    bus: EventBus<AgentEvent>,
    envelope: AgentEventEnvelope,
): void {
    if (envelope.durability === 'durable') {
        log.append(envelope.event);
        bus.emit(envelope.event);
        return;
    }
    bus.emit(envelope.event);
}

export function runtimeProjectContextOptions(options: AgentRuntimeOptions) {
    if (options.projectContext !== undefined) {
        return options.projectContext;
    }
    if (options.workspaceRoot === undefined) {
        return undefined;
    }
    return { workspaceRoot: options.workspaceRoot };
}

export function createRuntimeSession(timestamp: string): AgentSession {
    return {
        id: `session_${Date.now()}`,
        status: 'running',
        startedAt: timestamp,
    };
}

export function stopRuntimeSession(session: AgentSession | undefined, timestamp: string): AgentSession | undefined {
    if (session === undefined) {
        return undefined;
    }
    return {
        ...session,
        status: 'stopped',
        stoppedAt: timestamp,
    };
}

export function ensureRuntimeSession(session: AgentSession | undefined): AgentSession {
    if (session !== undefined) {
        return session;
    }
    throw new Error('AgentRuntime has not been started');
}

export function sessionStartedEvent(
    session: AgentSession,
    timestamp: string,
    nativeSidecarStatus: ReturnType<SidecarClient['status']>,
    modelProviderSelection: ModelProviderSelection,
): AgentEvent {
    return {
        type: 'session.started',
        timestamp,
        sessionId: session.id,
        message: 'mission-control session started',
        nativeSidecarStatus,
        modelProviderSelection,
    };
}

export function sessionStoppedEvent(input: {
    readonly timestamp: string;
    readonly sessionId?: string;
    readonly nativeSidecarStatus: ReturnType<SidecarClient['status']>;
    readonly modelProviderSelection: ModelProviderSelection;
}): AgentEvent {
    return {
        type: 'session.stopped',
        timestamp: input.timestamp,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        message: 'mission-control session stopped',
        nativeSidecarStatus: input.nativeSidecarStatus,
        modelProviderSelection: input.modelProviderSelection,
    };
}

export function taskStartedEvent(input: {
    readonly timestamp: string;
    readonly sessionId: string;
    readonly taskId: string;
    readonly prompt: string;
    readonly modelProviderSelection: ModelProviderSelection;
}): AgentEvent {
    return {
        type: 'task.started',
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        taskId: input.taskId,
        message: `user prompt: ${input.prompt}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
    };
}

export function taskCompletedEvent(input: {
    readonly timestamp: string;
    readonly sessionId: string;
    readonly taskId: string;
    readonly response: string;
    readonly modelProviderSelection: ModelProviderSelection;
}): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        taskId: input.taskId,
        message: input.response,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
    };
}

export function runBlockedEvent(input: {
    readonly timestamp: string;
    readonly sessionId: string;
    readonly taskId: string;
    readonly message: string;
    readonly errorCode: ProtocolErrorCode;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly toolCallId?: string;
}): AgentEvent {
    return {
        type: 'run.blocked',
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        taskId: input.taskId,
        message: input.message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        run: {
            command: 'run',
            state: 'blocked_on_approval',
            reason: input.message,
            errorCode: input.errorCode,
            ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        },
    };
}

export async function runRuntimePromptTask(input: {
    readonly options: AgentRuntimeOptions;
    readonly sessionId: string;
    readonly taskId: string;
    readonly prompt: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly onEnvelope: (envelope: AgentEventEnvelope) => void;
}): Promise<string> {
    if (input.options.provider === undefined) {
        return `received prompt: ${input.prompt}`;
    }
    const projectContext = runtimeProjectContextOptions(input.options);
    return runRuntimeProviderPromptTask({
        provider: input.options.provider,
        sessionId: input.sessionId,
        taskId: input.taskId,
        prompt: input.prompt,
        modelProviderSelection: input.modelProviderSelection,
        ...(projectContext !== undefined ? { projectContext } : {}),
        ...(input.options.providerTimeoutMs !== undefined
            ? { providerTimeoutMs: input.options.providerTimeoutMs }
            : {}),
        ...(input.options.providerRetryLimit !== undefined
            ? { providerRetryLimit: input.options.providerRetryLimit }
            : {}),
        ...(input.options.providerTurnLoopLimit !== undefined
            ? { providerTurnLoopLimit: input.options.providerTurnLoopLimit }
            : {}),
        ...(input.options.createToolRegistry !== undefined
            ? {
                  toolRegistry: await input.options.createToolRegistry(input.requestPermission),
              }
            : {}),
        requestPermission: input.requestPermission,
        onEnvelope: input.onEnvelope,
    });
}

export function blockedRuntimePromptMessage(error: RuntimeApprovalBlockedError): {
    readonly message: string;
    readonly errorCode: ProtocolErrorCode;
    readonly toolCallId?: string;
} {
    return {
        message: error.message,
        errorCode: error.errorCode,
        ...(error.toolCallId !== undefined ? { toolCallId: error.toolCallId } : {}),
    };
}
