import { afterEach, describe, expect, it } from 'vitest';
import {
    BOULDER_SCHEMA_VERSION,
    type BoulderState,
    BoulderStoreError,
    type BoulderWork,
    readBoulder,
    updateBoulderWork,
    writeBoulder,
} from './boulder-store.js';
import {
    appendNotepad,
    assertAppendOnly,
    NotepadAppendOnlyError,
    NotepadStoreError,
    readNotepad,
} from './notepad-store.js';
import { DEFAULT_OMO_SUBDIRS, ensureOmoDirs, isGitignored, OmoPersistenceError, resolveOmoRoot } from './paths.js';
import { PlanStoreError, parsePlanChecklist, parsePlanChecklistText, readPlan } from './plan-store.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'omo-test-'));
    tempRoots.push(root);
    return root;
}

function seedOmoRoot(root: string): string {
    mkdirSync(join(root, '.omo'), { recursive: true });
    return root;
}

describe('resolveOmoRoot', () => {
    it('walks up from a deeper path to find the enclosing .omo directory', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const deeper = join(root, 'packages', 'core', 'src', 'persistence');
        mkdirSync(deeper, { recursive: true });

        // When
        const resolved = await resolveOmoRoot(deeper);

        // Then
        expect(resolved).toBe(root);
    });

    it('throws an OmoPersistenceError when no .omo directory exists in any ancestor', async () => {
        // Given
        const root = makeTempRoot();
        const isolated = join(root, 'nope');

        // When / Then
        await expect(resolveOmoRoot(isolated)).rejects.toBeInstanceOf(OmoPersistenceError);
        await expect(resolveOmoRoot(isolated)).rejects.toMatchObject({ code: 'omo_root_not_found' });
    });
});

describe('ensureOmoDirs', () => {
    it('creates the default .omo subdirectories under root', async () => {
        // Given
        const root = makeTempRoot();

        // When
        const created = await ensureOmoDirs(root);

        // Then
        expect(created).toHaveLength(DEFAULT_OMO_SUBDIRS.length);
        for (const subdir of DEFAULT_OMO_SUBDIRS) {
            expect(existsSync(join(root, '.omo', subdir))).toBe(true);
        }
    });

    it('creates only the requested subdirs when an explicit list is provided', async () => {
        // Given
        const root = makeTempRoot();

        // When
        const created = await ensureOmoDirs(root, ['plans', 'missions']);

        // Then
        expect(created).toHaveLength(2);
        expect(existsSync(join(root, '.omo', 'plans'))).toBe(true);
        expect(existsSync(join(root, '.omo', 'missions'))).toBe(true);
        expect(existsSync(join(root, '.omo', 'notepads'))).toBe(false);
    });

    it('rejects unsafe subdir names', async () => {
        // Given
        const root = makeTempRoot();

        // When / Then
        await expect(ensureOmoDirs(root, ['../escape'])).rejects.toMatchObject({
            code: 'omo_unsafe_subdir',
        });
    });
});

describe('isGitignored', () => {
    it('detects a directory covered by a trailing-slash pattern', async () => {
        // Given
        const root = makeTempRoot();
        writeFileSync(join(root, '.gitignore'), ['.omo/', 'node_modules/'].join('\n'));
        const omoPath = join(root, '.omo');

        // When
        const ignored = await isGitignored(omoPath);

        // Then
        expect(ignored).toBe(true);
    });

    it('detects a basename covered by an unanchored pattern', async () => {
        // Given
        const root = makeTempRoot();
        writeFileSync(join(root, '.gitignore'), ['*.log', 'dist'].join('\n'));
        const logPath = join(root, 'app.log');

        // When
        const ignored = await isGitignored(logPath);

        // Then
        expect(ignored).toBe(true);
    });

    it('returns false for paths not covered by any pattern', async () => {
        // Given
        const root = makeTempRoot();
        writeFileSync(join(root, '.gitignore'), ['*.log'].join('\n'));
        const srcPath = join(root, 'src', 'index.ts');
        mkdirSync(join(root, 'src'), { recursive: true });

        // When
        const ignored = await isGitignored(srcPath);

        // Then
        expect(ignored).toBe(false);
    });

    it('respects negation patterns that un-ignore a path', async () => {
        // Given
        const root = makeTempRoot();
        writeFileSync(join(root, '.gitignore'), ['*.log', '!keep.log'].join('\n'));
        const keepPath = join(root, 'keep.log');

        // When
        const ignored = await isGitignored(keepPath);

        // Then
        expect(ignored).toBe(false);
    });
});

describe('boulder-store', () => {
    function sampleWork(overrides: Partial<BoulderWork> = {}): BoulderWork {
        return {
            work_id: 'work-1',
            active_plan: '/tmp/plan.md',
            plan_name: 'demo-plan',
            status: 'active',
            started_at: '2026-06-21T00:00:00.000Z',
            updated_at: '2026-06-21T00:00:00.000Z',
            session_ids: ['ses_1'],
            session_origins: { ses_1: 'direct' },
            task_sessions: {},
            ...overrides,
        };
    }

    function sampleState(overrides: Partial<BoulderState> = {}): BoulderState {
        const work = sampleWork();
        return {
            schema_version: BOULDER_SCHEMA_VERSION,
            active_work_id: work.work_id,
            works: { [work.work_id]: work },
            active_plan: work.active_plan,
            plan_name: work.plan_name,
            status: work.status,
            started_at: work.started_at,
            updated_at: work.updated_at,
            session_ids: work.session_ids,
            session_origins: work.session_origins,
            task_sessions: work.task_sessions,
            agent: 'atlas',
            ...overrides,
        };
    }

    it('returns null when boulder.json is absent', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When
        const state = await readBoulder(root);

        // Then
        expect(state).toBeNull();
    });

    it('round-trips a full boulder state through write then read', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const original = sampleState();

        // When
        await writeBoulder(root, original);
        const read = await readBoulder(root);

        // Then
        expect(read).not.toBeNull();
        expect(read?.schema_version).toBe(BOULDER_SCHEMA_VERSION);
        expect(read?.active_work_id).toBe('work-1');
        expect(read?.works['work-1']?.plan_name).toBe('demo-plan');
        expect(read?.works['work-1']?.task_sessions).toEqual({});
    });

    it('preserves passthrough fields the orchestrator may add', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const raw = {
            schema_version: BOULDER_SCHEMA_VERSION,
            active_work_id: 'work-x',
            works: {
                'work-x': {
                    work_id: 'work-x',
                    active_plan: '/tmp/x.md',
                    plan_name: 'x',
                    status: 'active',
                    started_at: '2026-06-21T00:00:00.000Z',
                    updated_at: '2026-06-21T00:00:00.000Z',
                    session_ids: [],
                    session_origins: {},
                    custom_orchestrator_field: 'keep-me',
                },
            },
            top_level_extra: true,
        };
        const file = join(root, '.omo', 'boulder.json');
        mkdirSync(join(root, '.omo'), { recursive: true });
        writeFileSync(file, `${JSON.stringify(raw)}\n`);

        // When
        const read = await readBoulder(root);

        // Then
        expect(read).not.toBeNull();
        const persisted = JSON.parse(readFileSync(file, 'utf8'));
        expect(persisted.works['work-x'].custom_orchestrator_field).toBe('keep-me');
        expect(persisted.top_level_extra).toBe(true);
    });

    it('throws BoulderStoreError on a corrupt boulder.json', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        writeFileSync(join(root, '.omo', 'boulder.json'), '{ not valid json');

        // When / Then
        await expect(readBoulder(root)).rejects.toBeInstanceOf(BoulderStoreError);
        await expect(readBoulder(root)).rejects.toMatchObject({ code: 'boulder_corrupt' });
    });

    it('updateBoulderWork merges patch fields and nested task_sessions', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        await writeBoulder(root, sampleState());

        // When
        const updated = await updateBoulderWork(
            root,
            'work-1',
            {
                status: 'completed',
                ended_at: '2026-06-21T01:00:00.000Z',
                task_sessions: {
                    'todo:1': {
                        task_key: 'todo:1',
                        task_label: '1',
                        task_title: 'First task',
                        status: 'completed',
                    },
                },
            },
            { now: () => '2026-06-21T01:00:00.000Z' },
        );

        // Then
        const work = updated.works['work-1'];
        expect(work?.status).toBe('completed');
        expect(work?.ended_at).toBe('2026-06-21T01:00:00.000Z');
        expect(work?.updated_at).toBe('2026-06-21T01:00:00.000Z');
        expect(work?.task_sessions?.['todo:1']?.task_title).toBe('First task');
    });

    it('updateBoulderWork adds a new task_session without dropping existing ones', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        await writeBoulder(
            root,
            sampleState({
                works: {
                    'work-1': sampleWork({
                        task_sessions: {
                            'todo:1': {
                                task_key: 'todo:1',
                                task_label: '1',
                                task_title: 'Existing',
                                status: 'completed',
                            },
                        },
                    }),
                },
            }),
        );

        // When
        const updated = await updateBoulderWork(
            root,
            'work-1',
            {
                task_sessions: {
                    'todo:2': {
                        task_key: 'todo:2',
                        task_label: '2',
                        task_title: 'New',
                        status: 'running',
                    },
                },
            },
            { now: () => '2026-06-21T02:00:00.000Z' },
        );

        // Then
        const sessions = updated.works['work-1']?.task_sessions;
        expect(Object.keys(sessions ?? {})).toEqual(['todo:1', 'todo:2']);
        expect(sessions?.['todo:2']?.status).toBe('running');
    });

    it('updateBoulderWork throws when the work id is unknown', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        await writeBoulder(root, sampleState());

        // When / Then
        await expect(updateBoulderWork(root, 'missing', { status: 'completed' })).rejects.toMatchObject({
            code: 'boulder_work_missing',
        });
    });
});

describe('plan-store checkbox parser', () => {
    it('counts top-level checked and unchecked boxes and excludes nested ones', () => {
        // Given
        const contents = [
            '# Plan',
            '',
            '- [ ] unchecked top level',
            '- [x] checked top level',
            '  - [ ] nested unchecked (should be ignored)',
            '    - [x] deeply nested (should be ignored)',
            '- [X] uppercase checked',
            '',
            'regular paragraph',
        ].join('\n');

        // When
        const checklist = parsePlanChecklistText(contents);

        // Then
        expect(checklist.total).toBe(3);
        expect(checklist.completed).toBe(2);
        expect(checklist.unchecked).toBe(1);
        expect(checklist.items.map((item) => item.text)).toEqual([
            'unchecked top level',
            'checked top level',
            'uppercase checked',
        ]);
    });

    it('returns total 0 for a header-only plan with no checkboxes', () => {
        // Given
        const contents = [
            '# ABG Workflow Implementation',
            '',
            '### Task 1.1 — Protocol additions',
            '',
            'Body text.',
            '',
            '### Task 1.2 — Permission rule algebra',
        ].join('\n');

        // When
        const checklist = parsePlanChecklistText(contents);

        // Then
        expect(checklist.total).toBe(0);
        expect(checklist.completed).toBe(0);
        expect(checklist.unchecked).toBe(0);
        expect(checklist.items).toEqual([]);
    });

    it('counts checkbox lines inside code fences (intentional line-scan)', () => {
        // Given
        const contents = ['```md', '- [ ] inside fence', '- [x] also inside', '```'].join('\n');

        // When
        const checklist = parsePlanChecklistText(contents);

        // Then
        expect(checklist.total).toBe(2);
        expect(checklist.completed).toBe(1);
    });

    it('reads and parses a real temp plan file end-to-end', async () => {
        // Given
        const root = makeTempRoot();
        const planPath = join(root, 'plan.md');
        writeFileSync(planPath, '- [ ] one\n- [x] two\n');

        // When
        const raw = await readPlan(planPath);
        const checklist = await parsePlanChecklist(planPath);

        // Then
        expect(raw).toContain('- [x] two');
        expect(checklist.total).toBe(2);
        expect(checklist.completed).toBe(1);
    });

    it('readPlan throws PlanStoreError when the plan is missing', async () => {
        // Given
        const planPath = join(makeTempRoot(), 'missing.md');

        // When / Then
        await expect(readPlan(planPath)).rejects.toBeInstanceOf(PlanStoreError);
        await expect(readPlan(planPath)).rejects.toMatchObject({ code: 'plan_missing' });
    });
});

describe('notepad-store append-only guard', () => {
    it('assertAppendOnly accepts a strict superset of existing content', () => {
        // Given / When / Then
        expect(() => assertAppendOnly('hello', 'hello world')).not.toThrow();
        expect(() => assertAppendOnly('', 'first append')).not.toThrow();
    });

    it('assertAppendOnly rejects a truncated write', () => {
        // Given / When / Then
        expect(() => assertAppendOnly('hello world', 'hello')).toThrow(NotepadAppendOnlyError);
    });

    it('assertAppendOnly rejects a rewrite that drops the prefix', () => {
        // Given / When / Then
        expect(() => assertAppendOnly('hello world', 'goodbye world')).toThrow(NotepadAppendOnlyError);
    });
});

describe('notepad-store appendNotepad', () => {
    it('appends a timestamped block and preserves previous content', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When
        await appendNotepad('demo-plan', 'learnings', '- first learning', {
            root,
            now: () => new Date('2026-06-21T10:00:00.000Z'),
        });
        await appendNotepad('demo-plan', 'learnings', '- second learning', {
            root,
            now: () => new Date('2026-06-21T11:00:00.000Z'),
        });

        // Then
        const contents = await readNotepad(root, 'demo-plan', 'learnings');
        expect(contents).toContain('- first learning');
        expect(contents).toContain('- second learning');
        expect(contents).toContain('2026-06-21T10:00:00.000Z');
        expect(contents).toContain('2026-06-21T11:00:00.000Z');
        // Ordering preserved (append-only).
        expect(contents.indexOf('first learning')).toBeLessThan(contents.indexOf('second learning'));
    });

    it('creates the notepad directory tree when it does not exist', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const expectedDir = join(root, '.omo', 'notepads', 'demo-plan');

        // When
        await appendNotepad('demo-plan', 'decisions', '- chose X', { root });

        // Then
        expect(existsSync(expectedDir)).toBe(true);
        expect(existsSync(join(expectedDir, 'decisions.md'))).toBe(true);
    });

    it('rejects writes for an unknown notepad file', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When / Then
        await expect(appendNotepad('demo-plan', 'secrets' as never, '- oops', { root })).rejects.toBeInstanceOf(
            NotepadStoreError,
        );
        await expect(appendNotepad('demo-plan', 'secrets' as never, '- oops', { root })).rejects.toMatchObject({
            code: 'notepad_unknown_file',
        });
    });

    it('rejects an unsafe plan name', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When / Then
        await expect(appendNotepad('../escape', 'learnings', 'x', { root })).rejects.toMatchObject({
            code: 'notepad_unsafe_plan_name',
        });
    });

    it('never truncates: file size strictly grows across appends', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When
        await appendNotepad('demo-plan', 'issues', 'first', {
            root,
            now: () => new Date('2026-06-21T10:00:00.000Z'),
        });
        const firstSize = readFileSync(join(root, '.omo', 'notepads', 'demo-plan', 'issues.md'), 'utf8').length;
        await appendNotepad('demo-plan', 'issues', 'second', {
            root,
            now: () => new Date('2026-06-21T10:05:00.000Z'),
        });
        const secondSize = readFileSync(join(root, '.omo', 'notepads', 'demo-plan', 'issues.md'), 'utf8').length;

        // Then
        expect(secondSize).toBeGreaterThan(firstSize);
    });
});
