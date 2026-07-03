import type { AbgNodeSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { appendNotepad, assertAppendOnly, NotepadAppendOnlyError, readNotepad } from '../persistence/notepad-store.js';
import { parsePlanSections } from '../persistence/plan-store.js';
import {
    createRunnerWorkflowGraph,
    RUNNER_CHECKBOX_UPDATE_PROMPT,
    RUNNER_DELEGATE_WORKER_PROMPT,
    RUNNER_DELEGATION_SECTIONS,
    RUNNER_INIT_NOTEPAD_PROMPT,
    RUNNER_PARSE_PLAN_PROMPT,
} from './runner-workflow-graph.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function nodeConfig(node: AbgNodeSpec | undefined, key: string): unknown {
    return node?.config?.[key];
}

function nodeById(graph: ReturnType<typeof createRunnerWorkflowGraph>, id: string): AbgNodeSpec | undefined {
    return graph.nodes.find((node) => node.id === id);
}

describe('runner workflow parity — section-scoped parsing wiring', () => {
    const graph = createRunnerWorkflowGraph();

    it('parse-plan node references the section-scoped parser contract', () => {
        const parsePlan = nodeById(graph, 'parse-plan');

        expect(nodeConfig(parsePlan, 'parser')).toBe('parsePlanSections');
        expect(nodeConfig(parsePlan, 'countedSections')).toEqual(['Todos', 'Final Verification Wave']);
    });

    it('parse-plan prompt instructs section-scoped counting under Todos and Final Verification Wave', () => {
        const parsePlan = nodeById(graph, 'parse-plan');
        const prompt = String(nodeConfig(parsePlan, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/## Todos/i);
        expect(prompt).toMatch(/Final Verification Wave/i);
        expect(prompt).toMatch(/nextTaskLabel/i);
        expect(prompt).toMatch(/Ignore nested/i);
    });

    it('nested checkboxes are ignored by the section-scoped parser', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] 1. top-level task',
            '  - [ ] nested acceptance criterion',
            '    - [x] deeply nested evidence',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. final check',
        ].join('\n');

        const result = parsePlanSections(markdown);

        expect(result.total).toBe(2);
        expect(result.items.map((item) => item.text)).toEqual(['1. top-level task', 'F1. final check']);
    });

    it('top-level 1. and F1. labeled items are parsed under counted headings', () => {
        const markdown = [
            '## TODOs',
            '',
            '- [ ] 1. Port atlas parser',
            '- [ ] 2. Wire notepad store',
            '',
            '## Final Verification Wave',
            '',
            '- [ ] F1. Goal verification',
            '- [ ] F2. Constraint verification',
        ].join('\n');

        const result = parsePlanSections(markdown);

        expect(result.total).toBe(4);
        expect(result.nextTaskLabel).toBe('1. Port atlas parser');
    });
});

describe('runner workflow parity — 6-section delegation contract', () => {
    const graph = createRunnerWorkflowGraph();
    const delegateWave = nodeById(graph, 'delegate-wave');
    const delegateWorker = nodeById(graph, 'delegate-worker');

    it('declares all six mandatory delegation sections in delegate-wave config', () => {
        const sections = nodeConfig(delegateWave, 'delegationSections');

        expect(sections).toEqual(['TASK', 'EXPECTED OUTCOME', 'REQUIRED TOOLS', 'MUST DO', 'MUST NOT DO', 'CONTEXT']);
    });

    it('RUNNER_DELEGATION_SECTIONS export matches the six mandatory sections', () => {
        expect([...RUNNER_DELEGATION_SECTIONS]).toEqual([
            'TASK',
            'EXPECTED OUTCOME',
            'REQUIRED TOOLS',
            'MUST DO',
            'MUST NOT DO',
            'CONTEXT',
        ]);
    });

    it('delegate-worker prompt references all six delegation sections', () => {
        const prompt = String(nodeConfig(delegateWorker, 'systemPrompt') ?? '');

        for (const section of RUNNER_DELEGATION_SECTIONS) {
            expect(prompt).toContain(section);
        }
    });

    it('delegate-worker prompt instructs appending findings to the notepad', () => {
        const prompt = String(nodeConfig(delegateWorker, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/append.*notepad|notepad.*append/i);
        expect(prompt).toMatch(/never overwrite/i);
    });
});

describe('runner workflow parity — parallel-by-default with dependency blocking', () => {
    const graph = createRunnerWorkflowGraph();
    const delegateWave = nodeById(graph, 'delegate-wave');
    const nextWave = nodeById(graph, 'next-wave');

    it('delegate-wave declares parallelByDefault and a dependency tracking key', () => {
        expect(nodeConfig(delegateWave, 'parallelByDefault')).toBe(true);
        expect(nodeConfig(delegateWave, 'dependencyKey')).toBe('plan.dependencies');
    });

    it('next-wave prompt instructs holding back dependency-blocked tasks', () => {
        const prompt = String(nodeConfig(nextWave, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/parallel/i);
        expect(prompt).toMatch(/dependenc/i);
        expect(prompt).toMatch(/block/i);
    });

    it('dependency-blocked tasks are not dispatched before blockers complete (graph contract)', () => {
        // The contract: parallelByDefault + dependencyKey means the wave fans out
        // all unblocked tasks in one shot, while blocked tasks wait. The next-wave
        // prompt enforces this by only placing dispatchable (dependency-satisfied)
        // task ids into wave.tasks.
        const nextWavePrompt = String(nodeConfig(nextWave, 'systemPrompt') ?? '');

        expect(nextWavePrompt).toMatch(/dependencies are\s+satisfied|dependency.*satisf/i);
        expect(nextWavePrompt).toMatch(/hold back|not.*dispatch/i);
    });
});

describe('runner workflow parity — verify-before-checkbox discipline', () => {
    const graph = createRunnerWorkflowGraph();
    const checkboxUpdate = nodeById(graph, 'checkbox-update');
    const perTaskVerify = nodeById(graph, 'per-task-verify');

    it('checkbox-update declares a plan-path write target', () => {
        expect(nodeConfig(checkboxUpdate, 'planPath')).toBe('.omo/plans/{slug}.md');
    });

    it('checkbox-update config gates the flip on verification', () => {
        expect(nodeConfig(checkboxUpdate, 'verifyBeforeCheckbox')).toBe(true);
        expect(nodeConfig(checkboxUpdate, 'readBackAfterUpdate')).toBe(true);
    });

    it('checkbox-update prompt MUST NOT flip on a child done claim alone', () => {
        const prompt = String(nodeConfig(checkboxUpdate, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/MUST NOT.*done.*claim|not.*based only.*done/i);
        expect(prompt).toMatch(/independently verify|verify.*before.*flip/i);
    });

    it('checkbox-update prompt requires read-back confirmation after flipping', () => {
        const prompt = String(nodeConfig(checkboxUpdate, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/after.*verif|only.*verif/i);
        expect(prompt).toMatch(/READ the plan/i);
        expect(prompt).toMatch(/read-back/i);
    });

    it('failed verification leaves the checkbox unchecked (prompt contract)', () => {
        const prompt = String(nodeConfig(checkboxUpdate, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/verification fails.*leave.*unchecked|leave.*unchecked.*fix-loop/i);
    });

    it('per-task-verify declares verifyBeforeCheckbox in its config', () => {
        expect(nodeConfig(perTaskVerify, 'verifyBeforeCheckbox')).toBe(true);
    });
});

describe('runner workflow parity — append-only notepad discipline', () => {
    const graph = createRunnerWorkflowGraph();
    const initNotepad = nodeById(graph, 'init-notepad');

    it('init-notepad declares the learnings notepad path and append-only mode', () => {
        expect(nodeConfig(initNotepad, 'notepadPath')).toBe('.omo/notepads/{plan}/learnings.md');
        expect(nodeConfig(initNotepad, 'notepadMode')).toBe('append-only');
    });

    it('init-notepad prompt references appendNotepad and assertAppendOnly', () => {
        const prompt = String(nodeConfig(initNotepad, 'systemPrompt') ?? '');

        expect(prompt).toMatch(/appendNotepad/i);
        expect(prompt).toMatch(/assertAppendOnly/i);
        expect(prompt).toMatch(/never overwrite/i);
    });

    it('RUNNER_INIT_NOTEPAD_PROMPT instructs reading the notepad before delegation', () => {
        expect(RUNNER_INIT_NOTEPAD_PROMPT).toMatch(/read.*learnings\.md|read.*notepad/i);
        expect(RUNNER_INIT_NOTEPAD_PROMPT).toMatch(/before delegation|inherited.?wisdom/i);
    });

    it('appendNotepad appends without truncating and readNotepad preserves content', async () => {
        const root = mkdtempSync(join(tmpdir(), 'runner-notepad-'));
        try {
            await appendNotepad('runner-test', 'learnings', 'first finding', { root });
            await appendNotepad('runner-test', 'learnings', 'second finding', { root });

            const content = await readNotepad(root, 'runner-test', 'learnings');

            expect(content).toContain('first finding');
            expect(content).toContain('second finding');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('assertAppendOnly rejects a proposed content that truncates the existing prefix', () => {
        const existing = 'line one\nline two\n';

        expect(() => assertAppendOnly(existing, 'line one\n')).toThrow(NotepadAppendOnlyError);
        expect(() => assertAppendOnly(existing, 'different prefix\nline two\n')).toThrow(NotepadAppendOnlyError);
        expect(() => assertAppendOnly(existing, 'line one\nline two\nline three\n')).not.toThrow();
    });
});

describe('runner workflow parity — read-back confirmation integration', () => {
    it('a section-scoped re-parse after a checkbox flip confirms the unchecked count decreased', () => {
        const root = mkdtempSync(join(tmpdir(), 'runner-readback-'));
        try {
            const planPath = join(root, 'plan.md');
            const before = [
                '## TODOs',
                '',
                '- [ ] 1. task A',
                '- [ ] 2. task B',
                '',
                '## Final Verification Wave',
                '',
                '- [ ] F1. check',
            ].join('\n');
            writeFileSync(planPath, before);

            const beforeResult = parsePlanSections(before);
            expect(beforeResult.unchecked).toBe(3);

            // Simulate a verified checkbox flip: task A checked.
            const after = before.replace('- [ ] 1. task A', '- [x] 1. task A');
            writeFileSync(planPath, after);

            const afterResult = parsePlanSections(after);
            expect(afterResult.unchecked).toBe(2);
            expect(afterResult.completed).toBe(1);
            expect(afterResult.nextTaskLabel).toBe('2. task B');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('runner workflow parity — exported prompt constants', () => {
    it('RUNNER_PARSE_PLAN_PROMPT documents the section-scoped contract', () => {
        expect(RUNNER_PARSE_PLAN_PROMPT).toMatch(/section-scoped/i);
        expect(RUNNER_PARSE_PLAN_PROMPT).toMatch(/Todos/i);
        expect(RUNNER_PARSE_PLAN_PROMPT).toMatch(/Final Verification Wave/i);
    });

    it('RUNNER_CHECKBOX_UPDATE_PROMPT documents verify-before-checkbox', () => {
        expect(RUNNER_CHECKBOX_UPDATE_PROMPT).toMatch(/MUST NOT.*based only.*done/i);
        expect(RUNNER_CHECKBOX_UPDATE_PROMPT).toMatch(/independently verify/i);
        expect(RUNNER_CHECKBOX_UPDATE_PROMPT).toMatch(/\.omo\/plans/i);
    });

    it('RUNNER_DELEGATE_WORKER_PROMPT lists all six sections', () => {
        for (const section of RUNNER_DELEGATION_SECTIONS) {
            expect(RUNNER_DELEGATE_WORKER_PROMPT).toContain(section);
        }
    });
});
