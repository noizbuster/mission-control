import {
    type ContextCacheUsage,
    deriveAbgGraphSnapshot,
    extractContextCacheUsage,
    extractContextTokensUsed,
    findResumableRun,
    latestGraphIdFromEvents,
    mergeGraphSnapshot,
    type ResumableRunSnapshot,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { AbgOverlayController, RunState } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';

export const RESUMABLE_ATTACH_BANNER = {
    approval: 'Resumable run: blocked on approval. Type /continue to resume work.',
    interrupted: 'Resumable run: interrupted. Type /continue to resume work.',
    recovery: 'Interrupted run can be safely recovered. Type /continue to inspect and continue outstanding work.',
} as const;

export type SessionAttachProjection = {
    readonly graphId: string | undefined;
    readonly resumable: ResumableRunSnapshot | undefined;
    readonly stickyBannerMessage: string | undefined;
    readonly overlayRunState: RunState | undefined;
    readonly contextTokensUsed: number | undefined;
    readonly contextCacheUsage: ContextCacheUsage | undefined;
};

export function projectSessionAttachFromEvents(events: readonly AgentEvent[]): SessionAttachProjection {
    const resumable = findResumableRun(events);
    const recoveryNeeded = resumable === undefined && hasRecoverableInterruptedTask(events);
    const graphId = latestGraphIdFromEvents(events) ?? resumable?.checkpoint?.graphId;
    return {
        graphId,
        resumable,
        stickyBannerMessage:
            stickyBannerForResumable(resumable) ?? (recoveryNeeded ? RESUMABLE_ATTACH_BANNER.recovery : undefined),
        overlayRunState: overlayRunStateForResumable(resumable) ?? (recoveryNeeded ? 'interrupted' : undefined),
        contextTokensUsed: latestContextTokensUsed(events),
        contextCacheUsage: sessionContextCacheUsage(events),
    };
}

export function applySessionAttachProjection(input: {
    readonly events: readonly AgentEvent[];
    readonly projection: SessionAttachProjection;
    readonly abgOverlayController: AbgOverlayController | undefined;
    readonly chatOutput: ChatOutput;
    readonly onUsage?: (inputTokens: number | undefined) => void;
    readonly onContextCacheUsage?: (usage: ContextCacheUsage | undefined) => void;
}): void {
    projectAbgOverlayOnAttach(input.abgOverlayController, input.events, input.projection);
    setStickyAttachBanner(input.chatOutput, input.projection.stickyBannerMessage);
    input.onUsage?.(input.projection.contextTokensUsed);
    input.onContextCacheUsage?.(input.projection.contextCacheUsage);
}

export function clearStickyAttachBanner(chatOutput: ChatOutput): void {
    if (chatOutput.setStickyNotice !== undefined) {
        chatOutput.setStickyNotice(null);
        return;
    }
}

function latestContextTokensUsed(events: readonly AgentEvent[]): number | undefined {
    let latest: number | undefined;
    for (const event of events) {
        const inputTokens = extractContextTokensUsed(event);
        if (inputTokens !== undefined) {
            latest = inputTokens;
        }
    }
    return latest;
}

function sessionContextCacheUsage(events: readonly AgentEvent[]): ContextCacheUsage | undefined {
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let hasUsage = false;
    for (const event of events) {
        const usage = extractContextCacheUsage(event);
        if (usage === undefined) continue;
        inputTokens += usage.inputTokens;
        cacheReadTokens += usage.cacheReadTokens;
        hasUsage = true;
    }
    if (!hasUsage || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(cacheReadTokens)) {
        return undefined;
    }
    return { inputTokens, cacheReadTokens };
}
function stickyBannerForResumable(resumable: ResumableRunSnapshot | undefined): string | undefined {
    if (resumable === undefined) return undefined;
    switch (resumable.kind) {
        case 'approval':
            return RESUMABLE_ATTACH_BANNER.approval;
        case 'interrupted':
            return isProviderAbortedRun(resumable)
                ? RESUMABLE_ATTACH_BANNER.recovery
                : RESUMABLE_ATTACH_BANNER.interrupted;
        default: {
            const _exhaustive: never = resumable;
            return _exhaustive;
        }
    }
}

function overlayRunStateForResumable(resumable: ResumableRunSnapshot | undefined): RunState | undefined {
    if (resumable === undefined) return undefined;
    switch (resumable.kind) {
        case 'approval':
            return 'blocked_on_approval';
        case 'interrupted':
            return 'interrupted';
        default: {
            const _exhaustive: never = resumable;
            return _exhaustive;
        }
    }
}

function isProviderAbortedRun(resumable: Extract<ResumableRunSnapshot, { readonly kind: 'interrupted' }>): boolean {
    return resumable.reason === 'provider_aborted' || resumable.errorCode === 'provider_aborted';
}

function hasRecoverableInterruptedTask(events: readonly AgentEvent[]): boolean {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.idle') {
            return false;
        }
        if (event.type === 'run.started') {
            return false;
        }
        if (event.type === 'task.failed' && event.run?.state === 'interrupted') {
            return true;
        }
    }
    return false;
}

function projectAbgOverlayOnAttach(
    controller: AbgOverlayController | undefined,
    events: readonly AgentEvent[],
    projection: SessionAttachProjection,
): void {
    if (controller === undefined) return;
    controller.store.reset();
    if (projection.graphId === undefined) {
        if (projection.overlayRunState !== undefined) {
            controller.store.update((draft) => {
                draft.runState = projection.overlayRunState ?? draft.runState;
            });
        }
        return;
    }
    const snapshot = deriveAbgGraphSnapshot(events, projection.graphId);
    const base = controller.store.getSnapshot();
    const patch = mergeGraphSnapshot(base, snapshot);
    controller.store.update((draft) => {
        Object.assign(draft, patch);
        if (projection.overlayRunState !== undefined) {
            draft.runState = projection.overlayRunState;
        }
    });
}

function setStickyAttachBanner(chatOutput: ChatOutput, message: string | undefined): void {
    if (chatOutput.setStickyNotice !== undefined) {
        chatOutput.setStickyNotice(message ?? null);
        return;
    }
    if (message !== undefined) {
        chatOutput.write(`${message}\n`);
    }
}
