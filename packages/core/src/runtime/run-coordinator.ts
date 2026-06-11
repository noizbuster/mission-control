import type {
    AgentEvent,
    AgentMessage,
    ModelProviderSelection,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import type { ProviderAdapter } from '../providers/provider-turn-types.js';
import { projectSessionAdmission } from '../session-admission-projection.js';
import { SessionAdmissionService } from '../session-admission-service.js';
import type { AdmitPromptInput, PromptInputState, SessionAdmissionEventStore } from '../session-admission-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import * as runAdmission from './run-coordinator-admission.js';
import { RunCoordinatorIdSequence } from './run-coordinator-ids.js';
import { runCoordinatorProviderTurn } from './run-coordinator-provider-turn.js';

export type RunCoordinatorStore = SessionAdmissionEventStore;

export type RunCoordinatorPromptInput = Omit<AdmitPromptInput, 'delivery' | 'inputId' | 'messageId'> & {
    readonly inputId?: string;
    readonly messageId?: string;
};

export type RunCoordinatorResult = {
    readonly status: 'idle' | 'running' | 'completed' | 'interrupted';
    readonly runId?: string;
    readonly turns: number;
};

export type SessionRunCoordinatorOptions = {
    readonly sessionId: string;
    readonly store: RunCoordinatorStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now?: () => string;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly createId?: (prefix: string, index: number) => string;
};

type DrainCommand = 'wake' | 'run' | 'resume';
type RunEventType = 'run.command.received' | 'run.started' | 'run.completed' | 'run.interrupted' | 'run.idle';
type ActiveRun = {
    readonly runId: string;
    readonly controller: AbortController;
    readonly promise: Promise<RunCoordinatorResult>;
    readonly settled: Promise<RunCoordinatorResult>;
};

export class SessionRunCoordinator {
    private readonly options: SessionRunCoordinatorOptions;
    private readonly admission: SessionAdmissionService;
    private readonly now: () => string;
    private readonly ids: RunCoordinatorIdSequence;
    private activeRun: ActiveRun | undefined;
    private appendQueue: Promise<void> = Promise.resolve();

    constructor(options: SessionRunCoordinatorOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
        this.ids = new RunCoordinatorIdSequence({
            sessionId: options.sessionId,
            store: options.store,
            createId: options.createId ?? ((prefix, index) => `${prefix}_${index}`),
        });
        this.admission = new SessionAdmissionService({
            sessionId: options.sessionId,
            store: options.store,
            now: this.now,
        });
    }

    async steer(input: RunCoordinatorPromptInput): Promise<void> {
        await this.admit('steer', input);
    }

    async queue(input: RunCoordinatorPromptInput): Promise<void> {
        await this.admit('queue', input);
    }

    wake(): Promise<RunCoordinatorResult> {
        return this.startDrain('wake');
    }

    run(): Promise<RunCoordinatorResult> {
        return this.startDrain('run');
    }

    resume(): Promise<RunCoordinatorResult> {
        return this.startDrain('resume');
    }

    async interrupt(reason = 'run interrupted'): Promise<RunCoordinatorResult> {
        const active = this.activeRun;
        const commandRecorded = this.appendRunEvent(
            'run.command.received',
            'interrupt',
            this.activeRun === undefined ? 'idle' : 'running',
            'run command: interrupt',
            {
                reason,
                ...(active?.runId !== undefined ? { runId: active.runId } : {}),
            },
        );
        active?.controller.abort();
        await commandRecorded;
        if (active === undefined) {
            return { status: 'idle', turns: 0 };
        }
        return active.settled;
    }

    private async admit(delivery: 'steer' | 'queue', input: RunCoordinatorPromptInput): Promise<void> {
        await this.ids.observe(input.inputId, input.messageId);
        const inputId = input.inputId ?? (await this.ids.next('input'));
        const messageId = input.messageId ?? (await this.ids.next('message'));
        const admittedInput = { ...input, inputId, messageId, delivery };
        await this.admission.assertCanAdmitPrompt(admittedInput);
        await this.appendRunEvent(
            'run.command.received',
            delivery,
            this.activeRun === undefined ? 'idle' : 'running',
            input.prompt,
            runAdmission.runMetadataForPromptInput(admittedInput),
        );
        await this.admission.admitPrompt(admittedInput);
    }

    private async startDrain(command: DrainCommand): Promise<RunCoordinatorResult> {
        if (this.activeRun !== undefined) {
            await this.appendRunEvent('run.command.received', command, 'running', `run command: ${command}`, {
                runId: this.activeRun.runId,
            });
            return this.activeRun.promise;
        }
        const runId = await this.ids.next('run');
        const controller = new AbortController();
        const promise = this.drain(command, runId, controller).finally(() => {
            this.activeRun = undefined;
        });
        this.activeRun = { runId, controller, promise, settled: promise };
        return promise;
    }

    private async drain(
        command: DrainCommand,
        runId: string,
        controller: AbortController,
    ): Promise<RunCoordinatorResult> {
        await this.appendRunEvent('run.command.received', command, 'idle', `run command: ${command}`, { runId });
        await this.appendRunEvent('run.started', command, 'running', 'run started', { runId });
        let turns = 0;
        let firstPromotion = true;

        while (!controller.signal.aborted) {
            const promotion =
                firstPromotion && command === 'wake'
                    ? await this.promoteWakeBatch()
                    : await this.promoteSingleRunInput();
            firstPromotion = false;
            if (promotion === 'idle' || (promotion === 'run_requested' && (turns > 0 || command === 'wake'))) {
                break;
            }
            const result = await this.runProviderTurn(controller.signal);
            turns += 1;
            if (result.status === 'interrupted') {
                await this.appendRunEvent('run.interrupted', command, 'interrupted', 'run interrupted', { runId });
                return { status: 'interrupted', runId, turns };
            }
        }

        const status = turns === 0 ? 'idle' : 'completed';
        const eventType = status === 'idle' ? 'run.idle' : 'run.completed';
        await this.appendRunEvent(eventType, command, status, status === 'idle' ? 'run idle' : 'run completed', {
            runId,
        });
        return { status, runId, turns };
    }

    private async runProviderTurn(signal: AbortSignal): Promise<{ readonly status: 'completed' | 'interrupted' }> {
        return runCoordinatorProviderTurn(
            {
                sessionId: this.options.sessionId,
                provider: this.options.provider,
                modelProviderSelection: this.options.modelProviderSelection,
                ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
                ...(this.options.retryLimit !== undefined ? { retryLimit: this.options.retryLimit } : {}),
                ...(this.options.toolCallLoopLimit !== undefined
                    ? { toolCallLoopLimit: this.options.toolCallLoopLimit }
                    : {}),
                ...(this.options.toolRegistry !== undefined ? { toolRegistry: this.options.toolRegistry } : {}),
                readMessages: () => this.modelVisibleMessages(),
                nextId: (prefix) => this.ids.next(prefix),
                appendDurableEvent: (event) => this.appendDurableEvent(event),
            },
            signal,
        );
    }

    private async promoteWakeBatch(): Promise<'promoted' | 'idle' | 'run_requested'> {
        const projection = await this.projectAdmission();
        if (projection.steeringInputs.length === 0) {
            return 'idle';
        }
        for (const input of projection.steeringInputs) {
            await this.promoteInput(input);
        }
        return 'promoted';
    }

    private async promoteSingleRunInput(): Promise<'promoted' | 'idle' | 'run_requested'> {
        const projection = await this.projectAdmission();
        const input = projection.steeringInputs.at(0) ?? projection.queuedInputs.at(0);
        if (input === undefined) {
            return 'run_requested';
        }
        await this.promoteInput(input);
        return 'promoted';
    }

    private async promoteInput(input: PromptInputState): Promise<void> {
        await this.appendDurableEvent(runAdmission.promptPromotionEvent(input, this.options.sessionId, this.now()));
    }

    private async projectAdmission(): Promise<ReturnType<typeof runAdmission.projectRunCoordinatorAdmission>> {
        return runAdmission.projectRunCoordinatorAdmission(
            await this.options.store.getEvents(this.options.sessionId),
            this.options.sessionId,
        );
    }

    private async modelVisibleMessages(): Promise<readonly AgentMessage[]> {
        const projection = projectSessionAdmission(
            await this.options.store.getEvents(this.options.sessionId),
            this.options.sessionId,
        );
        return projection.modelVisibleMessages.map((message) => ({ role: message.role, content: message.content }));
    }

    private async appendRunEvent(
        type: RunEventType,
        command: RunCoordinatorCommand,
        state: RunCoordinatorState,
        message: string,
        run: RunCoordinatorEventMetadata,
    ): Promise<void> {
        await this.appendDurableEvent({
            type,
            timestamp: this.now(),
            sessionId: this.options.sessionId,
            message,
            run: {
                command,
                state,
                ...run,
            },
        });
    }

    private appendDurableEvent(event: AgentEvent): Promise<void> {
        const write = this.appendQueue.then(() => this.options.store.append(event));
        this.appendQueue = write.catch(() => undefined);
        return write;
    }
}
