/** @jsxImportSource @opentui/solid */
import { testRender } from '@opentui/solid';
import { describe, expect, it, vi } from 'vitest';
import { createAbgOverlayStore } from '../state/abg-overlay-state';
import { AbgOverlay } from './AbgOverlay';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));

const OSC8 = '\u001B]8;;https://attacker.invalid\u0007';
const CSI = '\u001B[2J';
const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const CREDENTIAL = 'sk-abcdef';
const viewport = { columns: 120, rows: 30 } as const;

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

function expectTerminalControlsToBeEscaped(frame: string): void {
    expect(hasUnsafeTerminalControl(frame), frame).toBe(false);
    expect(frame).toContain('\\u{001B}');
    expect(frame).toContain('\\u{0007}');
    expect(frame).toContain('\\u{009B}');
    expect(frame).toContain('\\u{202E}');
}

describe('AbgOverlay terminal sanitization', () => {
    it('escapes graph display labels while preserving raw graph topology identity', async () => {
        const store = createAbgOverlayStore();
        const graphId = `計画${CREDENTIAL}${OSC8}${C1_CSI}${CSI}${BIDI}\n家族\u200D絵`;
        const nodeId = '\n';
        const edgeLabel = '遷移';
        const targetNodeId = '家族\u200D絵';
        store.update((draft) => {
            draft.activeGraphId = graphId;
            draft.focusedGraphId = graphId;
            draft.graphStatus = 'active';
            draft.runState = 'running';
            draft.nodes.set(nodeId, 'running');
            draft.nodes.set(targetNodeId, 'succeeded');
            draft.graphEdges.push({ source: nodeId, target: targetNodeId, condition: edgeLabel });
        });
        const setup = await testRender(
            () => (
                <AbgOverlay
                    store={store}
                    activeTab="graph"
                    scrollOffset={0}
                    modelLabel="local/local-echo"
                    viewport={viewport}
                />
            ),
            { width: viewport.columns, height: viewport.rows },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const state = store.getSnapshot();

            expect(frame).toContain('計画');
            expect(frame).toMatch(/計画[^\n]*\n[^\n]*家族/u);
            expect(frame).toContain('家族\u200D絵');
            expect(frame).toContain('\\u{000A}');
            expect(frame).toContain('[REDACTED_CREDENTIAL]');
            expect(frame).not.toContain(CREDENTIAL);
            expect(state.activeGraphId).toBe(graphId);
            expect(state.focusedGraphId).toBe(graphId);
            expect(state.nodes.get(nodeId)).toBe('running');
            expect(state.graphEdges).toEqual([{ source: nodeId, target: targetNodeId, condition: edgeLabel }]);
            expectTerminalControlsToBeEscaped(frame);
        } finally {
            setup.renderer.destroy();
        }
    });

    it('keeps colliding raw blackboard keys distinct while escaping their rendered labels and values', async () => {
        const store = createAbgOverlayStore();
        const rawKey = `goal${OSC8}`;
        const literalEscapeKey = 'goal\\u{001B}]8;;https://attacker.invalid\\u{0007}';
        const rawValue = `観測\n家族\u200D絵${C1_CSI}${BIDI}`;
        const nestedValue = { nested: { credential: CREDENTIAL } };
        store.update((draft) => {
            draft.blackboardEntries.set(rawKey, rawValue);
            draft.blackboardEntries.set(literalEscapeKey, 'literal-key-value');
            draft.blackboardEntries.set('metadata', nestedValue);
        });
        const setup = await testRender(
            () => (
                <AbgOverlay
                    store={store}
                    activeTab="blackboard"
                    scrollOffset={0}
                    modelLabel="local/local-echo"
                    viewport={viewport}
                />
            ),
            { width: viewport.columns, height: viewport.rows },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const entries = store.getSnapshot().blackboardEntries;

            expect(frame).toContain('観測');
            expect(frame).toContain('家族\u200D絵');
            expect(frame).toContain('literal-key-value');
            expect(frame).toContain('[REDACTED_CREDENTIAL]');
            expect(frame).not.toContain(CREDENTIAL);
            expect(entries).toHaveLength(3);
            expect(entries.get(rawKey)).toBe(rawValue);
            expect(entries.get(literalEscapeKey)).toBe('literal-key-value');
            expect(entries.get('metadata')).toBe(nestedValue);
            expectTerminalControlsToBeEscaped(frame);
        } finally {
            setup.renderer.destroy();
        }
    });
});
