import {
    deriveAbgGraphSnapshot,
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
} as const;

export type SessionAttachProjection = {
    readonly graphId: string | undefined;
    readonly resumable: ResumableRunSnapshot | undefined;
    readonly stickyBannerMessage: string | undefined;
    readonly overlayRunState: RunState | undefined;
};

export function projectSessionAttachFromEvents(events: readonly AgentEvent[]): SessionAttachProjection {
    const resumable = findResumableRun(events);
    const graphId = latestGraphIdFromEvents(events) ?? resumable?.checkpoint?.graphId;
    return {
        graphId,
        resumable,
        stickyBannerMessage: stickyBannerForResumable(resumable),
        overlayRunState: overlayRunStateForResumable(resumable),
    };
}

export function applySessionAttachProjection(input: {
    readonly events: readonly AgentEvent[];
    readonly projection: SessionAttachProjection;
    readonly abgOverlayController: AbgOverlayController | undefined;
    readonly chatOutput: ChatOutput;
}): void {
    projectAbgOverlayOnAttach(input.abgOverlayController, input.events, input.projection);
    setStickyAttachBanner(input.chatOutput, input.projection.stickyBannerMessage);
}

export function clearStickyAttachBanner(chatOutput: ChatOutput): void {
    if (chatOutput.setStickyNotice !== undefined) {
        chatOutput.setStickyNotice(null);
        return;
    }
}

function stickyBannerForResumable(resumable: ResumableRunSnapshot | undefined): string | undefined {
    if (resumable === undefined) return undefined;
    switch (resumable.kind) {
        case 'approval':
            return RESUMABLE_ATTACH_BANNER.approval;
        case 'interrupted':
            return RESUMABLE_ATTACH_BANNER.interrupted;
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
