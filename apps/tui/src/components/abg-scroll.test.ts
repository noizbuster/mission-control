import { describe, expect, test } from 'vitest';
import { scrolledSlice } from './abg-scroll';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('scrolledSlice', () => {
    test('offset 0 keeps full list', () => {
        expect(scrolledSlice(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    });

    test('positive offset skips leading rows', () => {
        expect(scrolledSlice(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
    });

    test('overscroll clamps to last item', () => {
        expect(scrolledSlice(['a', 'b'], 99)).toEqual(['b']);
    });

    test('empty list stays empty', () => {
        expect(scrolledSlice([], 3)).toEqual([]);
    });

    test('negative offset clamps to 0', () => {
        expect(scrolledSlice(['a', 'b'], -2)).toEqual(['a', 'b']);
    });
});

describe('ABG overlay reactive navigation source contract', () => {
    test('does not freeze activeTab via destructured switch/const isActive', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/AbgOverlay.tsx'), 'utf8');
        expect(source).toContain('const isActive = () => tab === props.activeTab');
        expect(source).toContain('<Match when={props.activeTab ===');
        expect(source).toContain('scrollOffset={props.scrollOffset}');
        expect(source).not.toMatch(/function PaneBody\(\{[\s\S]*activeTab[\s\S]*\}/);
        expect(source).not.toMatch(/const isActive = tab === activeTab/);
    });

    test('repaint effects track abgNavKey for tab/scroll paint', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/app/use-repaint-effects.ts'), 'utf8');
        const appSource = readFileSync(resolve(process.cwd(), 'apps/tui/src/app.tsx'), 'utf8');
        expect(source).toContain('abgNavKey');
        expect(appSource).toContain('abgNavKey:');
        expect(appSource).toContain('abgActiveTab()');
        expect(appSource).toContain('abgScrollOffset()');
    });
});
