import { describe, expect, it } from 'vitest';
import {
    createLoopSafetyNodeState,
    digestToolInput,
    failureSignatureFromActions,
    recordFailureTurn,
    recordToolTurn,
    turnSignatureFromActions,
    type ToolActionFingerprint,
} from './loop-safety.js';

function action(
    toolName: string,
    input: unknown,
    outcome: ToolActionFingerprint['outcome'] = 'completed',
    errorCode?: string,
): ToolActionFingerprint {
    return {
        toolName,
        inputDigest: digestToolInput(input),
        outcome,
        ...(errorCode !== undefined ? { errorCode } : {}),
    };
}

describe('loop-safety fingerprints', () => {
    it('canonicalizes object key order for digests', () => {
        expect(digestToolInput({ b: 1, a: 2 })).toBe(digestToolInput({ a: 2, b: 1 }));
    });

    it('builds a stable turn signature independent of action order', () => {
        const a = [action('grep', { pattern: 'x' }), action('read', { path: 'a.ts' })];
        const b = [action('read', { path: 'a.ts' }), action('grep', { pattern: 'x' })];
        expect(turnSignatureFromActions(a)).toBe(turnSignatureFromActions(b));
    });

    it('builds failure signatures from failed tools only', () => {
        const actions = [
            action('grep', { pattern: 'x' }, 'failed', 'timeout'),
            action('read', { path: 'a.ts' }, 'completed'),
        ];
        expect(failureSignatureFromActions(actions)).toContain('grep:timeout');
        expect(failureSignatureFromActions(actions)).not.toContain('read');
    });
});

describe('recordToolTurn', () => {
    it('soft-lands after identical consecutive tool turns', () => {
        const state = createLoopSafetyNodeState();
        const turn = [action('glob', { pattern: '**/*.ts' })];
        expect(recordToolTurn(state, turn)).toBeUndefined();
        expect(recordToolTurn(state, turn)).toBeUndefined();
        const trip = recordToolTurn(state, turn);
        expect(trip).toMatchObject({
            kind: 'soft_land',
            code: 'repeated_tool_pattern',
            streak: 3,
        });
    });

    it('resets streak when the tool turn changes', () => {
        const state = createLoopSafetyNodeState();
        const a = [action('glob', { pattern: '**/*.ts' })];
        const b = [action('glob', { pattern: '**/*.md' })];
        expect(recordToolTurn(state, a)).toBeUndefined();
        expect(recordToolTurn(state, a)).toBeUndefined();
        expect(recordToolTurn(state, b)).toBeUndefined();
        expect(state.identicalTurnStreak).toBe(1);
    });
});

describe('recordFailureTurn', () => {
    it('fails after identical consecutive failure combinations', () => {
        const state = createLoopSafetyNodeState();
        const fail = [action('bash', { cmd: 'x' }, 'failed', 'timeout')];
        expect(recordFailureTurn(state, fail)).toBeUndefined();
        expect(recordFailureTurn(state, fail)).toBeUndefined();
        const trip = recordFailureTurn(state, fail);
        expect(trip).toMatchObject({
            kind: 'fail',
            code: 'repeated_failure_pattern',
            streak: 3,
        });
    });

    it('accepts a fallback signature for node-level failures without tool actions', () => {
        const state = createLoopSafetyNodeState();
        expect(recordFailureTurn(state, [], undefined, 'node:provider_error')).toBeUndefined();
        expect(recordFailureTurn(state, [], undefined, 'node:provider_error')).toBeUndefined();
        const trip = recordFailureTurn(state, [], undefined, 'node:provider_error');
        expect(trip?.kind).toBe('fail');
    });
});
