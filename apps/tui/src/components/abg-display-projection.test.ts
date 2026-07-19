import { describe, expect, it } from 'vitest';
import {
    projectBlackboardEntriesForDisplay,
    projectVisualGraphInputForDisplay,
    sanitizeAbgDisplayText,
} from './abg-display-projection';
import type { VisualGraphEdge, VisualGraphInput, VisualGraphNode } from './visual-graph';

const OSC8 = '\u001B]8;;https://attacker.invalid\u0007';
const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const CREDENTIAL = 'sk-abcdef';

function hasUnsafeTerminalControl(text: string): boolean {
    return Array.from(text).some((character) => {
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

describe('ABG display projection', () => {
    it('escapes terminal controls while preserving CJK, newlines, and ZWJ', () => {
        const raw = `計画${CREDENTIAL}${OSC8}${C1_CSI}${BIDI}\n家族\u200D絵`;

        const displayed = sanitizeAbgDisplayText(raw);

        expect(displayed).toContain('計画');
        expect(displayed).toContain('\n家族\u200D絵');
        expect(displayed).toContain('[REDACTED_CREDENTIAL]');
        expect(displayed).not.toContain(CREDENTIAL);
        expect(displayed).toContain('\\u{001B}');
        expect(displayed).toContain('\\u{0007}');
        expect(displayed).toContain('\\u{009B}');
        expect(displayed).toContain('\\u{202E}');
        expect(hasUnsafeTerminalControl(displayed)).toBe(false);
    });

    it('projects graph labels to one line before layout without changing raw topology', () => {
        const sourceNodeId = `開始\n${CREDENTIAL}${C1_CSI}${BIDI}家族\u200D絵`;
        const targetNodeId = `完了${BIDI}`;
        const nodes: readonly VisualGraphNode[] = [
            { nodeId: sourceNodeId, status: 'running', isActive: true },
            { nodeId: targetNodeId, status: 'succeeded', isActive: false },
        ];
        const edges: readonly VisualGraphEdge[] = [
            { from: sourceNodeId, to: targetNodeId, label: `進行\n${CREDENTIAL}${C1_CSI}${BIDI}` },
        ];
        const input: VisualGraphInput = { nodes, edges, maxWidth: 100 };

        const displayed = projectVisualGraphInputForDisplay(input);
        const displayedText = [
            ...displayed.nodes.map((node) => node.nodeId),
            ...displayed.edges.map((edge) => edge.label ?? ''),
        ].join('');

        expect(nodes).toEqual([
            { nodeId: sourceNodeId, status: 'running', isActive: true },
            { nodeId: targetNodeId, status: 'succeeded', isActive: false },
        ]);
        expect(edges).toEqual([{ from: sourceNodeId, to: targetNodeId, label: `進行\n${CREDENTIAL}${C1_CSI}${BIDI}` }]);
        expect(displayedText).toContain('開始');
        expect(displayedText).toContain('完了');
        expect(displayedText).toContain('進行');
        expect(displayedText).toContain('家族\u200D絵');
        expect(displayedText).toContain('[REDACTED_CREDENTIAL]');
        expect(displayedText).toContain('\\u{000A}');
        expect(displayedText).not.toContain('\n');
        expect(hasUnsafeTerminalControl(displayedText)).toBe(false);
    });

    it('allocates collision-distinct graph labels around reserved suffix labels', () => {
        const rawBidiNodeId = `node${BIDI}`;
        const literalEscapeNodeId = 'node\\u{202E}';
        const reservedSuffixNodeId = 'node\\u{202E} [1/2]';
        const nodes: readonly VisualGraphNode[] = [
            { nodeId: rawBidiNodeId, status: 'running', isActive: true },
            { nodeId: literalEscapeNodeId, status: 'idle', isActive: false },
            { nodeId: reservedSuffixNodeId, status: 'succeeded', isActive: false },
        ];
        const edges: readonly VisualGraphEdge[] = [
            { from: rawBidiNodeId, to: literalEscapeNodeId, label: 'first' },
            { from: literalEscapeNodeId, to: reservedSuffixNodeId, label: 'second' },
        ];
        const input: VisualGraphInput = { nodes, edges, maxWidth: 100 };

        const displayed = projectVisualGraphInputForDisplay(input);

        expect(displayed.nodes.map((node) => node.nodeId)).toEqual([
            'node\\u{202E} [2/2]',
            'node\\u{202E} [1/2;2]',
            'node\\u{202E} [1/2]',
        ]);
        expect(displayed.edges).toEqual([
            { from: 'node\\u{202E} [2/2]', to: 'node\\u{202E} [1/2;2]', label: 'first' },
            { from: 'node\\u{202E} [1/2;2]', to: 'node\\u{202E} [1/2]', label: 'second' },
        ]);
        expect(input).toEqual({ nodes, edges, maxWidth: 100 });
    });

    it('retains colliding blackboard entries with deterministic display suffixes', () => {
        const rawKey = `goal${OSC8}`;
        const literalEscapeKey = 'goal\\u{001B}]8;;https://attacker.invalid\\u{0007}';
        const rawValue = `観測\n家族\u200D絵${C1_CSI}${BIDI}`;
        const nestedValue = { nested: { credential: CREDENTIAL, text: rawValue } };
        const entries = new Map<string, unknown>([
            [literalEscapeKey, 'literal-key-value'],
            [rawKey, rawValue],
            ['metadata', nestedValue],
        ]);

        const displayed = projectBlackboardEntriesForDisplay(entries);
        const displayedEntries = [...displayed.entries()];
        const collidingLabel = 'goal\\u{001B}]8;;https://attacker.invalid\\u{0007}';

        expect(displayedEntries).toEqual([
            [`${collidingLabel} [1/2]`, expect.stringContaining('観測\n家族\u200D絵')],
            [`${collidingLabel} [2/2]`, 'literal-key-value'],
            ['metadata', expect.stringContaining('家族\u200D絵')],
        ]);
        expect(displayed.get('metadata')).toContain('\\u{009B}');
        expect(displayed.get('metadata')).toContain('\\u{202E}');
        expect(displayed.get('metadata')).toContain('[REDACTED_CREDENTIAL]');
        expect(displayed.get('metadata')).not.toContain(CREDENTIAL);
        expect([...displayed.entries()].every(([key, value]) => !hasUnsafeTerminalControl(`${key}\n${value}`))).toBe(
            true,
        );
        expect([...entries.entries()]).toEqual([
            [literalEscapeKey, 'literal-key-value'],
            [rawKey, rawValue],
            ['metadata', nestedValue],
        ]);
    });
});
