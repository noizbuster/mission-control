import type {
    AgentModelLookup,
    AgentRuntime,
    ObservabilityRedactor,
    PersistentMemoryStore,
    ProviderAdapter,
} from '@mission-control/core';
import type { AbgGraphSpec, MissionControlConfig, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args';
import type { ProviderAuthStore } from '../auth-store';
import type { RunAgentOptions } from './run-agent-options';

export type RunNoninteractiveAgentInput = {
    readonly args: CliArgs;
    readonly options: RunAgentOptions;
    readonly runtime: AgentRuntime;
    readonly authStore: ProviderAuthStore;
    readonly provider: ProviderAdapter;
    readonly selectedModelProvider: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly config: MissionControlConfig;
    readonly graph?: AbgGraphSpec;
    readonly agentModelLookup?: AgentModelLookup;
    readonly persistentStore?: PersistentMemoryStore;
    readonly observabilityRedactor: ObservabilityRedactor;
};
