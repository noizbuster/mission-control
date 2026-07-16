import type { AbgNodeModelOptions, AbgNodeSpec, AbgPolicySpec, AgentEvent } from '@mission-control/protocol';
import type { ProjectInstructionResource } from '../context/project-context-messages';
import type { SystemPromptEnvironment } from '../context/system-prompt';
import type { Blackboard } from '../memory/blackboard';
import { redactAgentEventForObservability } from '../providers/observability-redactor';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import type { ToolRegistry } from '../tools/tool-registry';
import type { AuthorableAbgGraph } from './authorable-graph';
import type { CostLedger } from './budget/cost-ledger';
import type { CoordinatorState } from './graph-coordinator-helpers';
import type { AbgGraphRunnerInput } from './graph-runner';
import type { AbgNodeRegistry, AbgObservedGraphEvent } from './node-registry';
import type { LlmActorModel } from './nodes/llm-actor/llm-actor-node';

export type RunContextOptions = {
    readonly toolCallId?: string;
    readonly nodeId?: string;
};

export function runContext(
    graph: AuthorableAbgGraph,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    options: RunContextOptions = {},
) {
    const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    const model = graph.defaults?.model ?? runtimeModel(input.modelProviderSelection);
    const sdkModel = input.resolveSdkModel !== undefined ? input.resolveSdkModel(model) : undefined;
    const retryCorrection =
        options.nodeId !== undefined ? state.correctionByNodeId.get(options.nodeId) : undefined;
    return {
        graphId: graph.id,
        now: input.now,
        ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
        registry,
        nodes,
        policies: graph.policies,
        model,
        ...(sdkModel !== undefined ? { sdkModel } : {}),
        blackboard: state.blackboard,
        ...(state.budgetLedger !== undefined ? { budgetLedger: state.budgetLedger } : {}),
        ...(input.toolRegistry !== undefined ? { toolRegistry: input.toolRegistry } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
        ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
        ...(input.graphInput?.events !== undefined ? { observedEvents: input.graphInput.events } : {}),
        ...(input.graphInput?.input !== undefined ? { input: input.graphInput.input } : {}),
        emitEvent: (event) => {
            state.events.push(
                redactAgentEventForObservability(
                    {
                        ...event,
                        sessionId: input.sessionId,
                        modelProviderSelection: input.modelProviderSelection,
                    },
                    state.observabilityRedactor,
                ),
            );
        },
        ...(input.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
        ...(input.serializeToolExecution === true ? { serializeToolExecution: true } : {}),
        ...(input.systemPromptEnv !== undefined ? { systemPromptEnv: input.systemPromptEnv } : {}),
        ...(input.projectInstructionResources !== undefined
            ? { projectInstructionResources: input.projectInstructionResources }
            : {}),
        observabilityRedactor: state.observabilityRedactor,
        ...(retryCorrection !== undefined && retryCorrection.length > 0
            ? { retryCorrection }
            : {}),
    } satisfies {
        readonly graphId: string;
        readonly now: () => string;
        readonly toolCallId?: string;
        readonly registry: AbgNodeRegistry;
        readonly nodes: Readonly<Record<string, AbgNodeSpec | undefined>>;
        readonly policies: readonly AbgPolicySpec[];
        readonly model: AbgNodeModelOptions;
        readonly sdkModel?: LlmActorModel;
        readonly blackboard: Blackboard;
        readonly budgetLedger?: CostLedger;
        readonly toolRegistry?: ToolRegistry;
        readonly abortSignal?: AbortSignal;
        readonly controlEpoch?: SessionControlEpoch;
        readonly observedEvents?: readonly AbgObservedGraphEvent[];
        readonly input?: Readonly<Record<string, unknown>>;
        readonly emitEvent: (event: AgentEvent) => void;
        readonly haltOnFailedToolSettlement?: boolean;
        readonly serializeToolExecution?: boolean;
        readonly systemPromptEnv?: SystemPromptEnvironment;
        readonly projectInstructionResources?: readonly ProjectInstructionResource[];
        readonly observabilityRedactor: CoordinatorState['observabilityRedactor'];
        readonly retryCorrection?: string;
    };
}

function runtimeModel(modelProviderSelection: AbgGraphRunnerInput['modelProviderSelection']): AbgNodeModelOptions {
    return {
        providerID: modelProviderSelection.providerID,
        modelID: modelProviderSelection.modelID,
        ...(modelProviderSelection.variantID !== undefined ? { variantID: modelProviderSelection.variantID } : {}),
    };
}
