import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    PersistentMemoryStore,
    ProviderAdapter,
    SdkModelResolver,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import type { ProviderAuthStore } from '../auth-store.js';
import { closeTreeSitterClient } from '../components/markdown/highlight.js';
import { loadPersistedApprovalLevel, savePersistedApprovalLevel } from './approval-level-store.js';
import type { ChatInput, ChatOutput, ModelSelector, PlainPromptGraph } from './interactive-chat.js';
import { runInteractiveChatSession } from './interactive-chat.js';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { listAuthenticatedModelChoices } from './run-agent-model-selection.js';
import { closePersistentStore } from './run-agent-rendering.js';
import { createRunEventRecorder } from './run-agent-session.js';

type InteractiveRunOptions = {
    readonly chatInput?: ChatInput;
    readonly chatOutput?: ChatOutput;
    readonly selectModel?: ModelSelector;
    readonly modelDiscovery?: ModelDiscovery;
    readonly onRuntimeEvent?: (event: AgentEvent) => void;
    readonly provider?: ProviderAdapter;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly plainPromptGraph?: PlainPromptGraph;
};

type RunInteractiveAgentInput = {
    readonly args: CliArgs;
    readonly runtime: AgentRuntime;
    readonly authStore: ProviderAuthStore;
    readonly provider: ProviderAdapter;
    readonly selectedModelProvider: ModelProviderSelection;
    readonly createProvider: (selection: ModelProviderSelection) => ProviderAdapter;
    readonly workspaceRoot: string;
    readonly persistentStore: PersistentMemoryStore | undefined;
    readonly options: InteractiveRunOptions;
};

export async function runInteractiveAgent(input: RunInteractiveAgentInput): Promise<string> {
    const recorder = await createRunEventRecorder(input.args, { workspaceRoot: input.workspaceRoot });
    const emitRuntimeEvent = (event: AgentEvent) => {
        const recorded = recorder.record(event);
        input.options.onRuntimeEvent?.(recorded);
    };
    const observeStoredEvent = (event: AgentEvent) => {
        input.options.onRuntimeEvent?.(event);
    };
    const unsubscribeRuntimeEvents = input.runtime.onEvent(emitRuntimeEvent);
    let didStart = false;
    try {
        await input.runtime.start();
        didStart = true;
        const sessionStore = recorder.currentStore();
        const interactiveSessionId = input.args.sessionId ?? recorder.currentSessionId();
        const persistedApprovalLevel = await loadPersistedApprovalLevel();
        return await runInteractiveChatSession(input.runtime, {
            modelProviderSelection: input.selectedModelProvider,
            provider: input.provider,
            authStore: input.authStore,
            ...(interactiveSessionId !== undefined ? { sessionId: interactiveSessionId } : {}),
            workspaceRoot: input.workspaceRoot,
            modelChoices: await listAuthenticatedModelChoices(
                input.authStore,
                input.options.modelDiscovery ?? createDefaultModelDiscovery(),
            ),
            emitEvent: emitRuntimeEvent,
            observeStoredEvent,
            switchSessionStore: recorder.switchSession,
            ensureSession: recorder.ensureSession,
            ...(sessionStore !== undefined ? { sessionStore } : {}),
            ...(input.options.provider === undefined ? { resolveProviderForSelection: input.createProvider } : {}),
            persistModelProviderSelection: async (selection) => {
                await input.authStore.setDefaultSelection(selection);
            },
            ...(persistedApprovalLevel !== undefined ? { initialApprovalLevel: persistedApprovalLevel } : {}),
            persistApprovalLevel: async (level) => {
                await savePersistedApprovalLevel(level);
            },
            ...(input.options.commandExecutor !== undefined ? { commandExecutor: input.options.commandExecutor } : {}),
            ...(input.options.chatInput !== undefined ? { input: input.options.chatInput } : {}),
            ...(input.options.chatOutput !== undefined ? { output: input.options.chatOutput } : {}),
            ...(input.options.selectModel !== undefined ? { selectModel: input.options.selectModel } : {}),
            engine: 'graph',
            ...(input.options.resolveSdkModel !== undefined ? { resolveSdkModel: input.options.resolveSdkModel } : {}),
            ...(input.args.profileName !== undefined ? { profileName: input.args.profileName } : {}),
            ...(input.options.plainPromptGraph !== undefined
                ? { plainPromptGraph: input.options.plainPromptGraph }
                : {}),
        });
    } finally {
        if (didStart) {
            await input.runtime.stop();
        }
        unsubscribeRuntimeEvents?.();
        await recorder.close();
        closePersistentStore(input.persistentStore);
        await closeTreeSitterClient();
    }
}
