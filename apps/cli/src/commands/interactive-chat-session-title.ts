import {
    type ModelPattern,
    type ProviderAdapter,
    type ProviderAuthStore,
    type ProviderTurnRunInput,
    ProviderTurnRunner,
    redactCredentialText,
    redactProviderAuthStoreCredentialText,
} from '@mission-control/core';
import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';
import { cleanGeneratedSessionTitle, normalizeSessionPromptTitle } from './interactive-chat-session-title-text';
import { buildRoleConfigFromAuth } from './model-role-config';

export { cleanGeneratedSessionTitle, normalizeSessionPromptTitle };

const TITLE_SYSTEM_PROMPT =
    "Create one concise chat session title in the same language as the user's prompt. Focus only on the user's intent or topic. Do not answer the prompt, explain the title, or include tool names. Prefer 50 characters or fewer. Output the title only.";
const TITLE_PROVIDER_TIMEOUT_MS = 15_000;

let titleTurnSequence = 0;

export type SessionTitleSnapshot = {
    readonly sessionId: string | undefined;
    readonly displayName: string | undefined;
    readonly manualRenameRevision: number;
};

export type SessionTitleState = {
    readonly snapshot: () => SessionTitleSnapshot;
    readonly displayTitle: (title: string) => void;
    readonly persistTitle: (title: string) => Promise<void>;
    readonly enqueueWrite: SessionTitleWriteQueue;
};

export type SessionTitleWriteQueue = (write: () => Promise<void>) => Promise<void>;

export type SessionTitleModelContext = {
    readonly activeSelection: ModelProviderSelection;
    readonly activeProvider?: ProviderAdapter;
    readonly authStore?: ProviderAuthStore;
    readonly resolveProviderForSelection?: (selection: ModelProviderSelection) => ProviderAdapter;
};

type SessionTitleBase = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly state: SessionTitleState;
    readonly model: SessionTitleModelContext;
    readonly signal: AbortSignal;
};

type SessionTitleInitialization = SessionTitleBase & {
    readonly registerBackgroundTask: (task: Promise<void>) => void;
};

type SessionTitleGeneration = SessionTitleBase & {
    readonly promptTitle: string;
    readonly manualRenameRevision: number;
};

type TitleEligibility = {
    readonly sessionId: string;
    readonly expectedDisplayName: string | undefined;
    readonly manualRenameRevision: number;
};

type GeneratedTitleApplication = {
    readonly sessionId: string;
    readonly promptTitle: string;
    readonly generatedTitle: string;
    readonly manualRenameRevision: number;
    readonly state: SessionTitleState;
};

type TitleProviderCall = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly selection: ModelProviderSelection;
    readonly provider: ProviderAdapter;
    readonly signal: AbortSignal;
};

type Attempt<T> = { readonly status: 'completed'; readonly value: T } | { readonly status: 'failed' };

export function createSessionTitleWriteQueue(): SessionTitleWriteQueue {
    let writeTail = Promise.resolve();
    return (write) => {
        const result = writeTail.then(write, write);
        writeTail = result.then(ignore, ignore);
        return result;
    };
}

export function drainSessionTitleWriteQueue(enqueueWrite: SessionTitleWriteQueue): Promise<void> {
    return enqueueWrite(() => Promise.resolve());
}

export function selectSessionTitleModel(
    roleConfig: Partial<Record<ModelRole, ModelPattern>>,
    activeSelection: ModelProviderSelection,
): ModelProviderSelection {
    return (
        roleConfig.title ??
        roleConfig.smol ?? { providerID: activeSelection.providerID, modelID: activeSelection.modelID }
    );
}

export function createSessionTitleTurnInput(
    sessionId: string,
    prompt: string,
    selection: ModelProviderSelection,
): ProviderTurnRunInput {
    titleTurnSequence += 1;
    const uniqueId = `${sessionId}_${titleTurnSequence}`;
    return {
        sessionId,
        turnId: `title_turn_${uniqueId}`,
        requestId: `title_request_${uniqueId}`,
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        messages: [
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        startSequence: 0,
    };
}

export async function initializeInteractiveSessionTitle(input: SessionTitleInitialization): Promise<void> {
    const initialSnapshot = input.state.snapshot();
    if (initialSnapshot.displayName !== undefined && initialSnapshot.displayName.length > 0) return;
    const redactedPrompt = await settle(redactSessionTitleText(input.prompt, input.model.authStore));
    if (redactedPrompt.status === 'failed' || input.signal.aborted) return;
    const promptTitle = normalizeSessionPromptTitle(redactedPrompt.value);
    const manualRenameRevision = initialSnapshot.manualRenameRevision;
    const eligibility: TitleEligibility = {
        sessionId: input.sessionId,
        expectedDisplayName: initialSnapshot.displayName,
        manualRenameRevision,
    };
    let didPersist = false;
    const persistence = await settle(
        input.state.enqueueWrite(async () => {
            if (!canApplyTitle(input.state.snapshot(), eligibility)) return;
            await input.state.persistTitle(promptTitle);
            didPersist = true;
        }),
    );
    if (persistence.status === 'failed' || !didPersist || !canApplyTitle(input.state.snapshot(), eligibility)) {
        return;
    }

    input.state.displayTitle(promptTitle);
    input.registerBackgroundTask(
        runSessionTitleGeneration({
            sessionId: input.sessionId,
            prompt: redactedPrompt.value,
            state: input.state,
            model: input.model,
            signal: input.signal,
            promptTitle,
            manualRenameRevision,
        }),
    );
}

export async function runSessionTitleGeneration(input: SessionTitleGeneration): Promise<void> {
    if (input.signal.aborted) return;
    const roleConfig = await settle(
        input.model.authStore === undefined
            ? Promise.resolve<Partial<Record<ModelRole, ModelPattern>>>({})
            : buildRoleConfigFromAuth(input.model.authStore),
    );
    if (roleConfig.status === 'failed' || input.signal.aborted) return;
    const configuredSelection = roleConfig.value.title ?? roleConfig.value.smol;
    const selection = selectSessionTitleModel(roleConfig.value, input.model.activeSelection);
    if (selection.providerID === 'local' && selection.modelID === 'local-echo') return;
    const provider = await settle(
        Promise.resolve().then(() => {
            if (input.model.resolveProviderForSelection !== undefined) {
                return input.model.resolveProviderForSelection(selection);
            }
            return configuredSelection === undefined ? input.model.activeProvider : undefined;
        }),
    );
    if (provider.status === 'failed' || provider.value === undefined) return;

    const generated = await settle(
        generateSessionTitle({
            sessionId: input.sessionId,
            prompt: input.prompt,
            selection,
            provider: provider.value,
            signal: input.signal,
        }),
    );
    if (generated.status === 'failed') return;
    const redacted = await settle(redactSessionTitleText(generated.value, input.model.authStore));
    if (redacted.status === 'failed') return;
    const generatedTitle = cleanGeneratedSessionTitle(redacted.value);
    if (generatedTitle.length === 0 || generatedTitle === input.promptTitle) return;
    await applyGeneratedSessionTitle({
        sessionId: input.sessionId,
        promptTitle: input.promptTitle,
        generatedTitle,
        manualRenameRevision: input.manualRenameRevision,
        state: input.state,
    });
}

export async function applyGeneratedSessionTitle(input: GeneratedTitleApplication): Promise<boolean> {
    const eligibility: TitleEligibility = {
        sessionId: input.sessionId,
        expectedDisplayName: input.promptTitle,
        manualRenameRevision: input.manualRenameRevision,
    };
    if (!canApplyTitle(input.state.snapshot(), eligibility)) return false;
    let didPersist = false;
    const persistence = await settle(
        input.state.enqueueWrite(async () => {
            if (!canApplyTitle(input.state.snapshot(), eligibility)) return;
            await input.state.persistTitle(input.generatedTitle);
            didPersist = true;
        }),
    );
    if (persistence.status === 'failed' || !didPersist || !canApplyTitle(input.state.snapshot(), eligibility)) {
        return false;
    }
    input.state.displayTitle(input.generatedTitle);
    return true;
}

async function generateSessionTitle(input: TitleProviderCall): Promise<string> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TITLE_PROVIDER_TIMEOUT_MS)]);
    const result = await new ProviderTurnRunner({
        provider: input.provider,
        timeoutMs: TITLE_PROVIDER_TIMEOUT_MS,
        retryLimit: 0,
    }).runTurn({
        ...createSessionTitleTurnInput(input.sessionId, input.prompt, input.selection),
        signal,
    });
    return result.status === 'completed' ? result.message.content : '';
}

function redactSessionTitleText(text: string, authStore: ProviderAuthStore | undefined): Promise<string> {
    return authStore === undefined
        ? Promise.resolve(redactCredentialText(text))
        : redactProviderAuthStoreCredentialText(authStore, text);
}

function canApplyTitle(snapshot: SessionTitleSnapshot, expected: TitleEligibility): boolean {
    return (
        snapshot.sessionId === expected.sessionId &&
        snapshot.manualRenameRevision === expected.manualRenameRevision &&
        snapshot.displayName === expected.expectedDisplayName
    );
}

function settle<T>(promise: Promise<T>): Promise<Attempt<T>> {
    return promise.then(
        (value) => ({ status: 'completed', value }),
        () => ({ status: 'failed' }),
    );
}

function ignore(): undefined {
    return undefined;
}
