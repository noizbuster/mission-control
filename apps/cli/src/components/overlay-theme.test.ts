import { TextAttributes } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import type { OverlayVariant } from './overlay-theme.js';
import { ACCENTS, resolveOverlayChrome, SELECTED_BG } from './overlay-theme.js';

describe('overlay-theme SELECTED_BG', () => {
    it('pins the shared selection background constant', () => {
        expect(SELECTED_BG).toBe('#0000ff');
    });
});

describe('overlay-theme ACCENTS', () => {
    it('exposes the four accent slots with stable hex values', () => {
        expect(ACCENTS.default).toBe('#00ffff');
        expect(ACCENTS.approval).toBe('#ffff00');
        expect(ACCENTS.question).toBe('#ff00ff');
        expect(ACCENTS.error).toBe('#ff0000');
    });
});

describe('resolveOverlayChrome variant chrome flags', () => {
    it('marks the modal variant inverse+bold (no separator; the popup border delineates)', () => {
        const chrome = resolveOverlayChrome('modal');
        expect(chrome.inverse).toBe(true);
        expect(chrome.separator).toBe(false);
        expect(chrome.bold).toBe(true);
    });

    it('marks the panel variant non-inverse, no separator, bold', () => {
        const chrome = resolveOverlayChrome('panel');
        expect(chrome.inverse).toBe(false);
        expect(chrome.separator).toBe(false);
        expect(chrome.bold).toBe(true);
    });

    it('marks the view variant non-inverse, no separator, bold', () => {
        const chrome = resolveOverlayChrome('view');
        expect(chrome.inverse).toBe(false);
        expect(chrome.separator).toBe(false);
        expect(chrome.bold).toBe(true);
    });

    it('covers every declared OverlayVariant (exhaustive contract)', () => {
        const variants: readonly OverlayVariant[] = ['modal', 'panel', 'view'] as const;
        for (const variant of variants) {
            const chrome = resolveOverlayChrome(variant);
            expect(chrome.bold).toBe(true);
            expect(typeof chrome.headerFg).toBe('string');
            expect(Number.isInteger(chrome.headerAttrs)).toBe(true);
        }
    });
});

describe('resolveOverlayChrome headerFg accent resolution', () => {
    it('defaults headerFg to the default accent when no accent is passed', () => {
        expect(resolveOverlayChrome('modal').headerFg).toBe('#00ffff');
    });

    it('honors an explicit accent for headerFg', () => {
        expect(resolveOverlayChrome('modal', ACCENTS.approval).headerFg).toBe('#ffff00');
    });

    it('honors an arbitrary accent string for headerFg', () => {
        expect(resolveOverlayChrome('panel', '#abcdef').headerFg).toBe('#abcdef');
    });
});

describe('resolveOverlayChrome headerAttrs bitflag', () => {
    it('composes BOLD | INVERSE only for the inverse modal variant', () => {
        expect(resolveOverlayChrome('modal').headerAttrs).toBe(TextAttributes.BOLD | TextAttributes.INVERSE);
    });

    it('is plain BOLD for the non-inverse panel variant', () => {
        expect(resolveOverlayChrome('panel').headerAttrs).toBe(TextAttributes.BOLD);
    });

    it('is plain BOLD for the non-inverse view variant', () => {
        expect(resolveOverlayChrome('view').headerAttrs).toBe(TextAttributes.BOLD);
    });
});
