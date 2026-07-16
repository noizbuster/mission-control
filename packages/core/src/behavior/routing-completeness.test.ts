import { describe, expect, it } from 'vitest';
import {
    classifyRoutingProgress,
    isRoutingDeadEnd,
    type ClassifyRoutingProgressInput,
    type RoutingProgressClass,
} from './routing-completeness';

describe('classifyRoutingProgress', () => {
    it('classifies zero outbound edges as intentional_terminal', () => {
        // Given: present / complete / blocked-escalation style sink
        const input = baseInput({ outboundEdges: [] });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('intentional_terminal');
        expect(isRoutingDeadEnd(result)).toBe(false);
    });

    it('classifies config.terminal true as intentional_terminal even with edges', () => {
        // Given
        const input = baseInput({
            nodeConfig: { terminal: true },
            outboundEdges: [{ target: 'next', condition: 'never-matches' }],
            ruleMatches: () => false,
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('intentional_terminal');
    });

    it('classifies unconditional outbound edge as progressed', () => {
        // Given
        const input = baseInput({
            outboundEdges: [{ target: 'finish' }],
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('progressed');
    });

    it('classifies matching conditional edge as progressed', () => {
        // Given
        const input = baseInput({
            outboundEdges: [
                { target: 'clear-path', condition: 'is-clear' },
                { target: 'unclear-path', condition: 'is-unclear' },
            ],
            ruleMatches: (ruleId) => ruleId === 'is-clear',
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('progressed');
    });

    it('classifies conditional-only miss as dead_end', () => {
        // Given: pure gate with only equals edges; value does not match any
        const input = baseInput({
            outboundEdges: [
                { target: 'clear-path', condition: 'is-clear' },
                { target: 'unclear-path', condition: 'is-unclear' },
                { target: 'fence-path', condition: 'is-fence' },
            ],
            ruleMatches: () => false,
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('dead_end');
        expect(isRoutingDeadEnd(result)).toBe(true);
    });

    it('classifies valid select target as progressed even when edges miss', () => {
        // Given
        const input = baseInput({
            outboundEdges: [{ target: 'a', condition: 'nope' }],
            ruleMatches: () => false,
            selectTarget: 'recovery',
            selectTargetExists: true,
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('progressed');
    });

    it('does not treat invalid select target as progress when edges miss', () => {
        // Given
        const input = baseInput({
            outboundEdges: [{ target: 'a', condition: 'nope' }],
            ruleMatches: () => false,
            selectTarget: 'missing-node',
            selectTargetExists: false,
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('dead_end');
    });

    it('does not classify present/complete/blocked-escalation sinks as dead_end', () => {
        // Given: zero-outbound sinks used by workflows as intentional terminals
        const sinkIds = ['present', 'complete', 'blocked-escalation', 'plan-rejected-terminal'] as const;
        const results: RoutingProgressClass[] = [];

        // When
        for (const _sinkId of sinkIds) {
            results.push(classifyRoutingProgress(baseInput({ outboundEdges: [] })));
        }

        // Then
        expect(results.every((r) => r === 'intentional_terminal')).toBe(true);
        expect(results.some((r) => r === 'dead_end')).toBe(false);
    });

    it('prefers unconditional edge over dead_end when mixed with missing conditionals', () => {
        // Given
        const input = baseInput({
            outboundEdges: [
                { target: 'fallback' },
                { target: 'special', condition: 'special-rule' },
            ],
            ruleMatches: () => false,
        });

        // When
        const result = classifyRoutingProgress(input);

        // Then
        expect(result).toBe('progressed');
    });
});

function baseInput(overrides: Partial<ClassifyRoutingProgressInput> = {}): ClassifyRoutingProgressInput {
    return {
        outboundEdges: [],
        ruleMatches: () => false,
        ...overrides,
    };
}
