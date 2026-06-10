import type {
    AgentEvent,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';

export type SkillInvocationTaskInput = {
    readonly skillID: string;
    readonly argumentsText: string;
};

export type RuntimeSkillInvocationInput = {
    readonly task: SkillInvocationTaskInput;
    readonly sessionId: string;
    readonly taskId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly requestPermission: (request: PermissionRequest, taskId?: string) => Promise<PermissionDecision>;
    readonly emit: (event: AgentEvent) => void;
};

export async function runRuntimeSkillInvocationTask(input: RuntimeSkillInvocationInput): Promise<string> {
    await input.requestPermission(
        {
            id: `permission_${input.taskId}`,
            action: 'skill.invoke',
            reason: `skill invocation permission gate: ${input.task.skillID}`,
        },
        input.taskId,
    );
    input.emit({
        type: 'task.started',
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        message: `skill invocation started: ${input.task.skillID}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
    });
    const response = `skill invocation scaffolded: ${input.task.skillID}`;
    input.emit({
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        message: response,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
    });
    return response;
}
