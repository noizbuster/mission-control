/** @jsxImportSource @opentui/react */
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable } from '@opentui/core';

export type ChatTranscriptProps = {
    readonly children: React.ReactNode;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly maxHeight?: number;
};

/**
 * Native scrollbox config for the chat transcript. `stickyStart: 'bottom'` is a
 * literal so it stays assignable to ScrollBoxOptions' stickyStart union when spread.
 * Exported for headless tests (mirrors formatStatus / buildHeaderLabel precedent).
 */
export type ChatTranscriptScrollOptions = {
    readonly stickyScroll: true;
    readonly stickyStart: 'bottom';
    readonly scrollAcceleration: ScrollAcceleration;
    readonly flexGrow: 1;
    readonly width: '100%';
    readonly maxHeight?: number;
};

export function chatTranscriptScrollOptions(maxHeight?: number): ChatTranscriptScrollOptions {
    return {
        stickyScroll: true,
        stickyStart: 'bottom',
        scrollAcceleration: new MacOSScrollAccel(),
        flexGrow: 1,
        width: '100%',
        // exactOptionalPropertyTypes: never set maxHeight to undefined.
        ...(maxHeight !== undefined ? { maxHeight } : {}),
    };
}

/**
 * Thin wrapper over opentui's native <scrollbox> (ScrollBoxRenderable). The parent
 * drives imperative scroll via scrollboxRef.current.scrollTo/scrollBy/scrollHeight.
 * Windowing stays native; do not reimplement it here.
 */
export function ChatTranscript({ children, scrollboxRef, maxHeight }: ChatTranscriptProps): React.ReactNode {
    return (
        <scrollbox ref={scrollboxRef} {...chatTranscriptScrollOptions(maxHeight)}>
            {children}
        </scrollbox>
    );
}
