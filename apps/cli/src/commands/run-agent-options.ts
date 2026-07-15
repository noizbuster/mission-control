import type {
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
    SdkModelResolver,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store';
import type { NonInteractiveAutomationPolicy } from './cli-runtime-options';
import type { ChatInput, ChatOutput, ModelSelector, PlainPromptGraph } from './interactive-chat';
import type { ModelDiscovery } from './model-discovery';

export type RunAgentOptions = {
    readonly authStore?: ProviderAuthStore;
    readonly chatInput?: ChatInput;
    readonly chatOutput?: ChatOutput;
    readonly selectModel?: ModelSelector;
    readonly modelDiscovery?: ModelDiscovery;
    readonly onRuntimeEvent?: (event: AgentEvent) => void;
    readonly provider?: ProviderAdapter;
    readonly createProvider?: (selection: ModelProviderSelection) => ProviderAdapter;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly workspaceRoot?: string;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
    readonly plainPromptGraph?: PlainPromptGraph;
};
