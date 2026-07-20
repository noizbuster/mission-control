/**
 * Unit tests for deterministic dual-fix-gate runner (plan T6).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import { DUAL_REVIEW_RECEIPTS_HEADING } from '../../persistence/plan-scaffold';
import { PLANNER_DUAL_FIX_BUDGET } from '../planner-dual-review';
import { runDualFixGateNode } from './dual-fix-gate-node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-07-16T12:00:00.000Z';
const tempRoots: string[] = [];

afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

const GATE_NODE: AbgNodeSpec = {
    id: 'dual-fix-gate',
    kind: 'llm',
    implementation: 'dual-fix-gate',
    capabilities: [],
    config: {
        outputKey: 'dual.fix_route',
        outputEnum: ['revise', 'escalate'],
        fixKey: 'dual.fixes',
        fixBudget: PLANNER_DUAL_FIX_BUDGET,
        metisRejectKey: 'metis.rejects',
    },
};

function baseContext(
    blackboard: ReturnType<typeof createBlackboard>,
    workspaceRoot?: string,
) {
    return {
        graphId: 'planner',
        now: () => NOW,
        blackboard,
        ...(workspaceRoot !== undefined ? { systemPromptEnv: { workspaceRoot } } : {}),
    };
}

async function collect(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of signals) {
        out.push(signal);
    }
    return out;
}

describe('runDualFixGateNode', () => {
    it('routes revise, increments dual.fixes, and resets metis.rejects when fixes is 0', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('metis.rejects', 1);
        blackboard.set('dual.reviewer', 'REJECT');
        blackboard.set('dual.oracle', 'APPROVE');
        blackboard.set('dual.verdict', 'REJECT');
        // When
        const signals = await collect(runDualFixGateNode(GATE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('dual.fix_route')).toBe('revise');
        expect(blackboard.get('dual.fixes')).toBe(1);
        expect(blackboard.get('metis.rejects')).toBe(0);
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
    });

    it('routes escalate without incrementing when fixes is already at budget', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('dual.fixes', 1);
        blackboard.set('metis.rejects', 1);
        // When
        await collect(runDualFixGateNode(GATE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('dual.fix_route')).toBe('escalate');
        expect(blackboard.get('dual.fixes')).toBe(1);
        expect(blackboard.get('metis.rejects')).toBe(1);
    });

    it('treats a missing dual.fixes key as 0', async () => {
        const blackboard = createBlackboard();
        await collect(runDualFixGateNode(GATE_NODE, baseContext(blackboard)));
        expect(blackboard.get('dual.fix_route')).toBe('revise');
        expect(blackboard.get('dual.fixes')).toBe(1);
        expect(blackboard.get('metis.rejects')).toBe(0);
    });

    it('fails closed when the blackboard is unavailable', async () => {
        const signals = await collect(
            runDualFixGateNode(GATE_NODE, {
                graphId: 'planner',
                now: () => NOW,
            }),
        );
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'memory_unavailable' } });
    });

    it('emits dual_fix_gate.evaluated with route, counter, and receipt payload', async () => {
        const blackboard = createBlackboard();
        blackboard.set('dual.reviewer', 'REJECT');
        blackboard.set('dual.oracle', 'REJECT');
        blackboard.set('dual.verdict', 'REJECT');
        const signals = await collect(runDualFixGateNode(GATE_NODE, baseContext(blackboard)));
        const emit = signals.find(
            (signal) => signal.type === 'emit' && signal.event.type === 'dual_fix_gate.evaluated',
        );
        expect(emit).toBeDefined();
        if (emit?.type === 'emit') {
            expect(emit.event.payload).toEqual({
                dual_fixes: 0,
                dual_fixes_after: 1,
                fix_budget: 1,
                dual_fix_route: 'revise',
                dual_reviewer: 'REJECT',
                dual_oracle: 'REJECT',
                dual_verdict: 'REJECT',
                attempt: 1,
                metis_rejects_reset: true,
                dual_receipts_appended: false,
            });
        }
    });

    it('appends Dual review receipts to the draft when plan.slug and dual verdicts exist', async () => {
        // Given
        const root = await mkdtemp(join(tmpdir(), 'dual-fix-receipts-'));
        tempRoots.push(root);
        const blackboard = createBlackboard();
        blackboard.set('plan.slug', 'receipt-slug');
        blackboard.set('dual.reviewer', 'REJECT');
        blackboard.set('dual.oracle', 'APPROVE');
        blackboard.set('dual.verdict', 'REJECT');
        // When
        await collect(runDualFixGateNode(GATE_NODE, baseContext(blackboard, root)));
        // Then
        const draft = await readFile(join(root, '.mc', 'drafts', 'receipt-slug.md'), 'utf8');
        expect(draft).toContain(DUAL_REVIEW_RECEIPTS_HEADING);
        expect(draft).toContain('attempt 1: reviewer=REJECT, oracle=APPROVE, verdict=REJECT');
    });
});
