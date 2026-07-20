/**
 * Unit tests for deterministic draft-frontmatter runner (T3 / Must-have #4).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import { DUAL_REVIEW_RECEIPTS_HEADING } from '../../persistence/plan-scaffold';
import { runDraftFrontmatterNode } from './draft-frontmatter-node';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-07-16T12:00:00.000Z';
const tempRoots: string[] = [];

afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'draft-frontmatter-node-'));
    tempRoots.push(root);
    return root;
}

function draftingNode(): AbgNodeSpec {
    return {
        id: 'draft-frontmatter',
        kind: 'llm',
        implementation: 'draft-frontmatter',
        capabilities: [],
        config: { status: 'drafting' },
    };
}

function awaitingNode(): AbgNodeSpec {
    return {
        id: 'draft-awaiting-approval',
        kind: 'llm',
        implementation: 'draft-frontmatter',
        capabilities: [],
        config: { status: 'awaiting-approval', appendDualReceipts: true },
    };
}

function baseContext(blackboard: ReturnType<typeof createBlackboard>, workspaceRoot: string) {
    return {
        graphId: 'planner',
        now: () => NOW,
        blackboard,
        systemPromptEnv: { workspaceRoot },
    };
}

async function collect(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of signals) {
        out.push(signal);
    }
    return out;
}

describe('runDraftFrontmatterNode', () => {
    it('writes status=drafting with intent and review_required from the blackboard', async () => {
        // Given
        const root = await makeTempRoot();
        const blackboard = createBlackboard();
        blackboard.set('plan.slug', 'auth-rewrite');
        blackboard.set('intent', 'clear');
        blackboard.set('review_required', true);
        // When
        const signals = await collect(runDraftFrontmatterNode(draftingNode(), baseContext(blackboard, root)));
        // Then
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
        const draft = await readFile(join(root, '.mc', 'drafts', 'auth-rewrite.md'), 'utf8');
        expect(draft).toContain('slug: auth-rewrite');
        expect(draft).toContain('status: drafting');
        expect(draft).toContain('intent: clear');
        expect(draft).toContain('review_required: true');
    });

    it('preserves an existing draft body when updating frontmatter', async () => {
        // Given
        const root = await makeTempRoot();
        await mkdir(join(root, '.mc', 'drafts'), { recursive: true });
        const draftPath = join(root, '.mc', 'drafts', 'keep-body.md');
        await writeFile(
            draftPath,
            ['---', 'slug: keep-body', 'status: drafting', 'intent: ""', 'review_required: false', '---', '', '# Body', ''].join(
                '\n',
            ),
            'utf8',
        );
        const blackboard = createBlackboard();
        blackboard.set('plan.slug', 'keep-body');
        blackboard.set('intent', 'unclear');
        // When
        await collect(runDraftFrontmatterNode(awaitingNode(), baseContext(blackboard, root)));
        // Then
        const draft = await readFile(draftPath, 'utf8');
        expect(draft).toContain('status: awaiting-approval');
        expect(draft).toContain('intent: unclear');
        expect(draft).toContain('# Body');
    });

    it('appends dual review receipts when appendDualReceipts is true and dual keys exist', async () => {
        // Given
        const root = await makeTempRoot();
        const blackboard = createBlackboard();
        blackboard.set('plan.slug', 'dual-receipts');
        blackboard.set('intent', 'clear');
        blackboard.set('review_required', true);
        blackboard.set('dual.reviewer', 'APPROVE');
        blackboard.set('dual.oracle', 'APPROVE');
        blackboard.set('dual.verdict', 'APPROVE');
        blackboard.set('dual.fixes', 0);
        // When
        await collect(runDraftFrontmatterNode(awaitingNode(), baseContext(blackboard, root)));
        // Then
        const draft = await readFile(join(root, '.mc', 'drafts', 'dual-receipts.md'), 'utf8');
        expect(draft).toContain(DUAL_REVIEW_RECEIPTS_HEADING);
        expect(draft).toContain('reviewer=APPROVE');
        expect(draft).toContain('oracle=APPROVE');
        expect(draft).toContain('verdict=APPROVE');
    });

    it('fails when plan.slug is missing', async () => {
        const root = await makeTempRoot();
        const blackboard = createBlackboard();
        const signals = await collect(runDraftFrontmatterNode(draftingNode(), baseContext(blackboard, root)));
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'missing_plan_slug' } });
    });
});
