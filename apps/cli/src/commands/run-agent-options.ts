import type {
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
    SdkModelResolver,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';
import type { NonInteractiveAutomationPolicy } from './cli-runtime-options.js';
import type { ChatInput, ChatOutput, ModelSelector, PlainPromptGraph } from './interactive-chat.js';
import type { ModelDiscovery } from './model-discovery.js';

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
