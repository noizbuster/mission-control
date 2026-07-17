import {
    CheckpointCoordinator,
    createCheckpointToolRegistration,
    createRewindToolRegistration,
    registerDebugTool,
    registerGoalTool,
    registerPlanExitTool,
    registerReportFindingTool,
    registerReportToolIssueTool,
    type ToolRegistry,
} from '@mission-control/core';
import type { RegisterDefaultCodingToolsOptions } from './register-default-coding-tools';

export function registerDefaultOrchestrationTools(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
): void {
    const checkpointCoordinator = new CheckpointCoordinator();
    registry.register(createCheckpointToolRegistration({ coordinator: checkpointCoordinator }));
    registry.register(createRewindToolRegistration({ coordinator: checkpointCoordinator }));

    if (options.reportToolIssueSink !== undefined) {
        registerReportToolIssueTool(registry, { enabled: true, onIssue: options.reportToolIssueSink });
    }
    if (options.hostKind === 'interactive' && options.planExit !== undefined) {
        registerPlanExitTool(registry, options.planExit);
    }
    if (options.goalRuntime !== undefined) {
        registerGoalTool(registry, { runtime: options.goalRuntime });
    }
    registerDebugTool(registry, { enabled: options.config.debug?.enabled === true });
    if (options.reportFinding !== undefined) {
        registerReportFindingTool(registry, options.reportFinding);
    }
}
