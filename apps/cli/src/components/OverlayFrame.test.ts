import { describe, expect, it } from 'vitest';
import { OverlayFrame } from './OverlayFrame.js';
import { resolveOverlayChrome } from './overlay-theme.js';

describe('OverlayFrame export shape', () => {
    it('exports a presentational function component', () => {
        expect(typeof OverlayFrame).toBe('function');
    });
});

describe('OverlayFrame chrome wire-up contract', () => {
    it('resolves modal chrome with separator so <Separator> renders first', () => {
        const chrome = resolveOverlayChrome('modal');
        expect(chrome.separator).toBe(true);
        expect(chrome.inverse).toBe(true);
        expect(chrome.bold).toBe(true);
    });

    it('resolves panel chrome non-inverse so no INVERSE header attrs', () => {
        const chrome = resolveOverlayChrome('panel');
        expect(chrome.inverse).toBe(false);
        expect(chrome.separator).toBe(false);
        expect(chrome.bold).toBe(true);
    });

    it('resolves view chrome bold and non-inverse for the title+hint row', () => {
        const chrome = resolveOverlayChrome('view');
        expect(chrome.bold).toBe(true);
        expect(chrome.inverse).toBe(false);
        expect(chrome.separator).toBe(false);
    });
});
