import type { AbgNodeModelOptions, AbgNodeSpec, AbgPolicySpec, AgentEvent } from '@mission-control/protocol';
import type { ProjectInstructionResource } from '../context/project-context-messages.js';
import type { SystemPromptEnvironment } from '../context/system-prompt.js';
import type { Blackboard } from '../memory/blackboard.js';
import { redactAgentEventForObservability } from '../providers/observability-redactor.js';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import type { CostLedger } from './budget/cost-ledger.js';
import type { CoordinatorState } from './graph-coordinator-helpers.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import type { AbgNodeRegistry, AbgObservedGraphEvent } from './node-registry.js';
import type { LlmActorModel } from './nodes/llm-actor/llm-actor-node.js';

export function runContext(
    graph: AuthorableAbgGraph,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    toolCallId?: string,
) {
    const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    const model = graph.defaults?.model ?? runtimeModel(input.modelProviderSelection);
    const sdkModel = input.resolveSdkModel !== undefined ? input.resolveSdkModel(model) : undefined;
    return {
        graphId: graph.id,
        now: input.now,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
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
    };
}

function runtimeModel(modelProviderSelection: AbgGraphRunnerInput['modelProviderSelection']): AbgNodeModelOptions {
    return {
        providerID: modelProviderSelection.providerID,
        modelID: modelProviderSelection.modelID,
        ...(modelProviderSelection.variantID !== undefined ? { variantID: modelProviderSelection.variantID } : {}),
    };
}
