/** @jsxImportSource @opentui/solid */
import { testRender } from '@opentui/solid';
import { describe, expect, it, vi } from 'vitest';
import { createAbgOverlayStore } from '../state/abg-overlay-state';
import { AbgMinimap } from './AbgMinimap';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));

const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const CREDENTIAL = 'sk-abcdef';
const viewport = { columns: 48, rows: 20 } as const;

function hasUnsafeTerminalControl(frame: string): boolean {
    return Array.from(frame).some((character) => {
        const codePoint = character.codePointAt(0) ?? -1;
        return (
            (codePoint <= 0x1f && codePoint !== 0x0a) ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x061c ||
            codePoint === 0x200e ||
            codePoint === 0x200f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x2069)
        );
    });
}

describe('AbgMinimap terminal sanitization', () => {
    it('escapes terminal controls in minimap node labels while retaining raw topology keys', async () => {
        const store = createAbgOverlayStore();
        const sourceNodeId = '\n';
        const targetNodeId = `家族\u200D絵${C1_CSI}`;
        const credentialNodeId = `${CREDENTIAL}${BIDI}`;
        store.update((draft) => {
            draft.activeGraphId = 'minimap-graph';
            draft.graphStatus = 'active';
            draft.nodes.set(sourceNodeId, 'running');
            draft.nodes.set(targetNodeId, 'idle');
            draft.nodes.set(credentialNodeId, 'succeeded');
            draft.graphEdges.push(
                { source: sourceNodeId, target: targetNodeId, condition: '進行' },
                { source: targetNodeId, target: credentialNodeId, condition: '完了' },
            );
        });
        const setup = await testRender(() => <AbgMinimap store={store} viewport={viewport} />, {
            width: viewport.columns,
            height: viewport.rows,
        });

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const state = store.getSnapshot();

            expect(frame).toContain('家族\u200D絵');
            expect(frame).not.toContain(CREDENTIAL);
            expect(frame).toContain('\\u{000A}');
            expect(state.nodes.get(sourceNodeId)).toBe('running');
            expect(state.nodes.get(targetNodeId)).toBe('idle');
            expect(state.nodes.get(credentialNodeId)).toBe('succeeded');
            expect(state.graphEdges).toEqual([
                { source: sourceNodeId, target: targetNodeId, condition: '進行' },
                { source: targetNodeId, target: credentialNodeId, condition: '完了' },
            ]);
            expect(hasUnsafeTerminalControl(frame), frame).toBe(false);
            expect(frame).toContain('\\u{');
        } finally {
            setup.renderer.destroy();
        }
    });

});
