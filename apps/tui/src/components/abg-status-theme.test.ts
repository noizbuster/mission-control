import { ABG_GRAPH_STATUSES, ABG_NODE_STATUSES } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { graphStatusTheme, nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme.js';

/**
 * Table-driven coverage over the protocol status unions. `it.each` iterates the
 * live `ABG_*_STATUSES` arrays exported from `@mission-control/protocol`, so a
 * newly added status that the helper switch does not handle throws via the
 * `never` default and fails these tests — the stop condition for T3.
 */

describe('abg-status-theme nodeStatusTheme', () => {
    it.each(ABG_NODE_STATUSES)('returns a non-empty glyph for node status %s', (status) => {
        const theme = nodeStatusTheme(status);
        expect(typeof theme.glyph).toBe('string');
        expect(theme.glyph.length).toBeGreaterThan(0);
    });

    it.each(ABG_NODE_STATUSES)('returns a well-formed foreground for node status %s', (status) => {
        const theme = nodeStatusTheme(status);
        // foreground is optional (idle/starting carry none); when present it must be a hex color.
        if (theme.foreground !== undefined) {
            expect(theme.foreground).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it('pins a glyph snapshot for every node status (fails if a status is added or re-glyphed unintentionally)', () => {
        const glyphs = ABG_NODE_STATUSES.map((status) => nodeStatusTheme(status).glyph);
        // Order matches ABG_NODE_STATUSES: idle, starting, running, succeeded, failed, cancelled, blocked.
        expect(glyphs).toEqual(['∙', '○', '▶', '✓', '✗', '⊘', '⏸']);
    });

    it('renders running/succeeded/failed/blocked/cancelled nodes with a colored foreground, and idle/starting without one', () => {
        expect(nodeStatusTheme('running').foreground).toBe('#ffff00');
        expect(nodeStatusTheme('succeeded').foreground).toBe('#00ff00');
        expect(nodeStatusTheme('failed').foreground).toBe('#ff0000');
        expect(nodeStatusTheme('blocked').foreground).toBe('#00ffff');
        expect(nodeStatusTheme('cancelled').foreground).toBe(STATUS_FG_GRAY);
        expect(nodeStatusTheme('idle').foreground).toBeUndefined();
        expect(nodeStatusTheme('starting').foreground).toBeUndefined();
    });
});

describe('abg-status-theme graphStatusTheme', () => {
    it.each(ABG_GRAPH_STATUSES)('returns a non-empty glyph for graph status %s', (status) => {
        const theme = graphStatusTheme(status);
        expect(typeof theme.glyph).toBe('string');
        expect(theme.glyph.length).toBeGreaterThan(0);
    });

    it.each(ABG_GRAPH_STATUSES)('returns a hex foreground for graph status %s', (status) => {
        const theme = graphStatusTheme(status);
        // Graph statuses always carry an explicit foreground (created/cancelled share gray).
        expect(theme.foreground).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('pins a glyph+foreground snapshot for every graph status (fails if a status is added or recolored unintentionally)', () => {
        const entries = ABG_GRAPH_STATUSES.map((status) => {
            const theme = graphStatusTheme(status);
            return [theme.glyph, theme.foreground];
        });
        // Order matches ABG_GRAPH_STATUSES: created, active, blocked, completed, failed, cancelled.
        expect(entries).toEqual([
            ['○', STATUS_FG_GRAY],
            ['▶', '#ffff00'],
            ['⏸', '#00ffff'],
            ['✓', '#00ff00'],
            ['✗', '#ff0000'],
            ['⊘', STATUS_FG_GRAY],
        ]);
    });
});
