import { createEffect } from 'solid-js';
import { useTuiToast } from '../platform/providers/index.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { ChatStore } from '../state/chat-store.js';

/**
 * Bridges ChatStore.transientNotice into the provider toast service so store
 * notices surface as ephemeral toasts without App owning toast state.
 */
export function useTransientToast(store: ChatStore): void {
    const toast = useTuiToast();
    const transientNotice = useSolidStoreSelector(store, (state) => state.transientNotice);

    createEffect(() => {
        const noticeId = transientNotice()?.id;
        const noticeMessage = transientNotice()?.message;
        if (noticeId !== undefined && noticeMessage !== undefined) {
            toast.show({ message: noticeMessage, variant: 'info' });
        }
    });
}
