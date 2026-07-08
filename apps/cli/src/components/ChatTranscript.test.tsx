import { MacOSScrollAccel, type ScrollBoxRenderable } from '@opentui/core';
import { isValidElement, type ReactNode, type RefObject } from 'react';
import { describe, expect, it } from 'vitest';
import {
    ChatTranscriptScrollbox,
    type ChatTranscriptScrollOptions,
    chatTranscriptScrollOptions,
    MarkdownPanel,
    MessageBlock,
} from './ChatTranscript.js';
import { darkTheme } from './markdown/theme.js';

type ScrollboxElementProps = ChatTranscriptScrollOptions & {
    readonly children?: ReactNode;
};

function scrollboxProps(node: ReactNode): ScrollboxElementProps {
    if (!isValidElement<ScrollboxElementProps>(node)) {
        throw new Error('expected a scrollbox element');
    }
    return node.props;
}

describe('chatTranscriptScrollOptions', () => {
    it('builds the native scrollbox config with sticky-bottom macOS acceleration', () => {
        const opts = chatTranscriptScrollOptions();
        expect(opts.stickyScroll).toBe(true);
        expect(opts.stickyStart).toBe('bottom');
        expect(opts.scrollAcceleration).toBeInstanceOf(MacOSScrollAccel);
        expect(opts.flexGrow).toBe(1);
        expect(opts.width).toBe('100%');
    });

    it('omits maxHeight when none is given (honors exactOptionalPropertyTypes)', () => {
        const opts = chatTranscriptScrollOptions();
        expect(opts).not.toHaveProperty('maxHeight');
    });

    it('includes maxHeight when a value is given', () => {
        const opts = chatTranscriptScrollOptions(24);
        expect(opts.maxHeight).toBe(24);
    });

    it('keeps maxHeight when the value is 0 (does not treat 0 as absent)', () => {
        const opts = chatTranscriptScrollOptions(0);
        expect(opts.maxHeight).toBe(0);
    });

    it('preserves sticky-bottom behavior when resize changes the transcript height', () => {
        const tall = chatTranscriptScrollOptions(24);
        const short = chatTranscriptScrollOptions(10);

        expect([tall.stickyScroll, tall.stickyStart, tall.width, tall.maxHeight]).toEqual([true, 'bottom', '100%', 24]);
        expect([short.stickyScroll, short.stickyStart, short.width, short.maxHeight]).toEqual([
            true,
            'bottom',
            '100%',
            10,
        ]);
        expect(short.scrollAcceleration).toBeInstanceOf(MacOSScrollAccel);
    });
});

describe('ChatTranscriptScrollbox component', () => {
    it('is a callable React component', () => {
        expect(typeof ChatTranscriptScrollbox).toBe('function');
    });

    it('does not throw when constructed with children and a scrollbox ref', () => {
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };
        expect(() => {
            void (
                <ChatTranscriptScrollbox scrollboxRef={scrollboxRef}>
                    <text>hello</text>
                </ChatTranscriptScrollbox>
            );
        }).not.toThrow();
    });

    it('does not throw when constructed with null children and a maxHeight (failure scenario)', () => {
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };
        expect(() => {
            void (
                <ChatTranscriptScrollbox scrollboxRef={scrollboxRef} maxHeight={10}>
                    {null}
                </ChatTranscriptScrollbox>
            );
        }).not.toThrow();
    });

    it('threads resize height changes into the native scrollbox without dropping sticky-bottom props', () => {
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };

        const tall = scrollboxProps(
            ChatTranscriptScrollbox({ scrollboxRef, maxHeight: 24, children: 'transcript line' }),
        );
        const short = scrollboxProps(
            ChatTranscriptScrollbox({ scrollboxRef, maxHeight: 10, children: 'transcript line' }),
        );

        expect([tall.stickyScroll, tall.stickyStart, tall.width, tall.maxHeight]).toEqual([true, 'bottom', '100%', 24]);
        expect([short.stickyScroll, short.stickyStart, short.width, short.maxHeight]).toEqual([
            true,
            'bottom',
            '100%',
            10,
        ]);
    });
});

describe('MessageBlock component (memoized)', () => {
    it('does not throw when constructed with a streaming assistant block', () => {
        expect(() => {
            void (
                <MessageBlock
                    block={{ kind: 'assistant', lines: ['Assistant: hello'] }}
                    isStreaming={true}
                    toolOutputExpanded={false}
                />
            );
        }).not.toThrow();
    });

    it('does not throw when constructed with a collapsed tool block', () => {
        expect(() => {
            void (
                <MessageBlock
                    block={{ kind: 'tool', lines: ['Command preview for command.run', '$ ls'] }}
                    toolOutputExpanded={false}
                />
            );
        }).not.toThrow();
    });
});

describe('MarkdownPanel component (memoized)', () => {
    it('does not throw when constructed with streaming enabled', () => {
        expect(() => {
            void (
                <MarkdownPanel text="# heading" theme={darkTheme} barColor="#00ff00" barWidth={1} streaming={true} />
            );
        }).not.toThrow();
    });

    it('does not throw when constructed without streaming and a marginTop', () => {
        expect(() => {
            void (<MarkdownPanel text="plain text" theme={darkTheme} barColor="#ff00ff" barWidth={2} marginTop={1} />);
        }).not.toThrow();
    });
});
