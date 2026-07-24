import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    ObservabilityRedactor,
    PersistentMemoryStore,
    ProviderAdapter,
    SdkModelResolver,
} from '@mission-control/core';
import { redactAgentEventForObservability } from '@mission-control/core';
import type {
    AgentEvent,
    AgentSnapshot,
    MissionControlConfig,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { closeTreeSitterClient } from '@mission-control/tui/highlight';
import type { CliArgs } from '../args';
import type { ProviderAuthStore } from '../auth-store';
import { createSessionFinalizeEvent } from '../ui/session-finalize';
import { loadPersistedApprovalLevel, savePersistedApprovalLevel } from './approval-level-store';
import type { ChatInput, ChatOutput, ModelSelector, PlainPromptGraph } from './interactive-chat';
import { runInteractiveChatSession } from './interactive-chat';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery';
import { listAuthenticatedModelChoices } from './run-agent-model-selection';
import { closePersistentStore } from './run-agent-rendering';
import { createRunEventRecorder } from './run-agent-session';

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
    readonly config: MissionControlConfig;
    readonly persistentStore: PersistentMemoryStore | undefined;
    readonly options: InteractiveRunOptions;
    readonly observabilityRedactor: ObservabilityRedactor;
};

export async function runInteractiveAgent(input: RunInteractiveAgentInput): Promise<string> {
    const recorder = await createRunEventRecorder(input.args, {
        workspaceRoot: input.workspaceRoot,
        observabilityRedactor: input.observabilityRedactor,
    });
    const tuiEventListeners = new Set<(event: AgentEvent) => void>();
    const emitRuntimeEvent = (event: AgentEvent) => {
        const recorded = recorder.record(event);
        input.options.onRuntimeEvent?.(recorded);
        for (const listener of tuiEventListeners) {
            listener(recorded);
        }
    };
    const observeStoredEvent = (event: AgentEvent) => {
        const observableEvent = redactAgentEventForObservability(event, input.observabilityRedactor);
        input.options.onRuntimeEvent?.(observableEvent);
        for (const listener of tuiEventListeners) {
            listener(observableEvent);
        }
    };
    const subscribeEvents = (listener: (event: AgentEvent) => void): (() => void) => {
        tuiEventListeners.add(listener);
        return () => {
            tuiEventListeners.delete(listener);
        };
    };
    const loadSessionSnapshot = (): AgentSnapshot => {
        return input.runtime.getSnapshot();
    };
    const unsubscribeRuntimeEvents = input.runtime.onEvent(emitRuntimeEvent);
    let didStart = false;
    const sessionFinalizeSink: { info?: import('../ui/session-finalize').SessionFinalizeInfo } = {};
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
            observabilityRedactor: input.observabilityRedactor,
            ...(interactiveSessionId !== undefined ? { sessionId: interactiveSessionId } : {}),
            workspaceRoot: input.workspaceRoot,
            config: input.config,
            modelChoices: await listAuthenticatedModelChoices(
                input.authStore,
                input.options.modelDiscovery ?? createDefaultModelDiscovery(),
            ),
            emitEvent: emitRuntimeEvent,
            observeStoredEvent,
            subscribeEvents,
            loadSessionSnapshot,
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
            sessionFinalizeSink,
        });
    } finally {
        if (didStart) {
            await input.runtime.stop();
        }
        if (sessionFinalizeSink.info !== undefined && recorder.shouldFinalizeCurrentSession()) {
            try {
                const finalizeTimestamp = new Date().toISOString();
                const finalizeSessionId = recorder.currentSessionId();
                emitRuntimeEvent(
                    createSessionFinalizeEvent(sessionFinalizeSink.info, {
                        timestamp: finalizeTimestamp,
                        ...(finalizeSessionId !== undefined ? { sessionId: finalizeSessionId } : {}),
                    }),
                );
            } catch {
                // session.finalize emit is best-effort; resume readability is not load-bearing.
            }
        }
        unsubscribeRuntimeEvents?.();
        await recorder.close();
        closePersistentStore(input.persistentStore);
        await closeTreeSitterClient();
    }
}
