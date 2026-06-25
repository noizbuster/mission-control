import { describe, expect, it } from 'vitest';
import { MacOSScrollAccel, type ScrollBoxRenderable } from '@opentui/core';
import type { RefObject } from 'react';
import { chatTranscriptScrollOptions, ChatTranscript } from './ChatTranscript.js';

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
});

describe('ChatTranscript component', () => {
    it('is a callable React component', () => {
        expect(typeof ChatTranscript).toBe('function');
    });

    it('does not throw when constructed with children and a scrollbox ref', () => {
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };
        expect(() => {
            void (
                <ChatTranscript scrollboxRef={scrollboxRef}>
                    <text>hello</text>
                </ChatTranscript>
            );
        }).not.toThrow();
    });

    it('does not throw when constructed with null children and a maxHeight (failure scenario)', () => {
        const scrollboxRef: RefObject<ScrollBoxRenderable | null> = { current: null };
        expect(() => {
            void (
                <ChatTranscript scrollboxRef={scrollboxRef} maxHeight={10}>
                    {null}
                </ChatTranscript>
            );
        }).not.toThrow();
    });
});
