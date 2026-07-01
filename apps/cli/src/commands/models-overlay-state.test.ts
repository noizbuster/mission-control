import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    assignSelectedRole,
    clearSelectedRole,
    createModelsOverlayRoleRows,
    createModelsOverlayState,
    createModelsOverlayView,
    formatRoleFallback,
    type ModelsOverlayRoleRow,
    navigateModelsOverlayDown,
    navigateModelsOverlayUp,
    switchModelsOverlayColumn,
} from './models-overlay-state.js';

function selection(providerID: string, modelID: string, variantID?: string): ModelProviderSelection {
    return { providerID, modelID, ...(variantID !== undefined ? { variantID } : {}) };
}

const FALLBACK = selection('a', 'b');
const ENTRIES = [selection('p1', 'm1'), selection('p2', 'm2'), selection('p3', 'm3')] as const;

function roleRows(
    assignments: Partial<Record<ModelRole, ModelProviderSelection>> = {},
): readonly ModelsOverlayRoleRow[] {
    return createModelsOverlayRoleRows(assignments, FALLBACK);
}

describe('createModelsOverlayRoleRows', () => {
    it('returns 10 rows in MODEL_ROLE_IDS order', () => {
        const rows = roleRows();
        expect(rows).toHaveLength(10);
        expect(rows.map((row) => row.role)).toEqual([
            'default',
            'smol',
            'slow',
            'vision',
            'plan',
            'designer',
            'commit',
            'title',
            'task',
            'advisor',
        ]);
    });

    it('carries the persisted assignment when present and undefined otherwise', () => {
        const rows = roleRows({ slow: selection('x', 'y') });
        expect(rows[2]?.role).toBe('slow');
        expect(rows[2]?.assignment).toEqual(selection('x', 'y'));
        expect(rows[0]?.assignment).toBeUndefined();
    });
});

describe('formatRoleFallback', () => {
    it('formats a non-default role as Using default', () => {
        const row: ModelsOverlayRoleRow = { role: 'slow', assignment: undefined, fallback: FALLBACK };
        expect(formatRoleFallback(row)).toBe('Using default (a/b)');
    });

    it('formats the default role as Using built-in/session default', () => {
        const row: ModelsOverlayRoleRow = { role: 'default', assignment: undefined, fallback: FALLBACK };
        expect(formatRoleFallback(row)).toBe('Using built-in/session default (a/b)');
    });

    it('includes the variant suffix when present', () => {
        const row: ModelsOverlayRoleRow = {
            role: 'slow',
            assignment: undefined,
            fallback: selection('a', 'b', 'v'),
        };
        expect(formatRoleFallback(row)).toBe('Using default (a/b#v)');
    });
});

describe('navigateModelsOverlayDown', () => {
    it('moves the left index down when the left column is focused', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const next = navigateModelsOverlayDown(state);
        expect(next.activeLeftIndex).toBe(1);
    });

    it('clamps at the bottom of the column', () => {
        const state = createModelsOverlayState([ENTRIES[0]!], roleRows());
        const next = navigateModelsOverlayDown(state);
        expect(next.activeLeftIndex).toBe(0);
    });

    it('returns the same reference when clamped (purity)', () => {
        const state = createModelsOverlayState([ENTRIES[0]!], roleRows());
        const next = navigateModelsOverlayDown(state);
        expect(next).toBe(state);
    });

    it('moves the right index when the right column is focused', () => {
        const state = switchModelsOverlayColumn(createModelsOverlayState(ENTRIES, roleRows()));
        const next = navigateModelsOverlayDown(state);
        expect(next.activeRightIndex).toBe(1);
    });
});

describe('navigateModelsOverlayUp', () => {
    it('moves the left index up and clamps at the top', () => {
        const downOnce = navigateModelsOverlayDown(createModelsOverlayState(ENTRIES, roleRows()));
        const back = navigateModelsOverlayUp(downOnce);
        expect(back.activeLeftIndex).toBe(0);
    });

    it('clamps at the top of the column returning the same reference', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const next = navigateModelsOverlayUp(state);
        expect(next.activeLeftIndex).toBe(0);
        expect(next).toBe(state);
    });
});

describe('switchModelsOverlayColumn', () => {
    it('toggles the focused column while preserving indices', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        expect(state.focusedColumn).toBe('left');
        const right = switchModelsOverlayColumn(state);
        expect(right.focusedColumn).toBe('right');
        expect(right.activeLeftIndex).toBe(state.activeLeftIndex);
        expect(right.activeRightIndex).toBe(state.activeRightIndex);
        const left = switchModelsOverlayColumn(right);
        expect(left.focusedColumn).toBe('left');
    });
});

describe('assignSelectedRole', () => {
    it('updates the focused role row with the focused left model', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const assigned = assignSelectedRole(state);
        expect(assigned.roleRows[0]?.assignment).toEqual(ENTRIES[0]);
    });

    it('does not mutate the input state', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const snapshot = state.roleRows[0]?.assignment;
        assignSelectedRole(state);
        expect(state.roleRows[0]?.assignment).toBe(snapshot);
    });

    it('returns the input unchanged when the left column is empty', () => {
        const state = createModelsOverlayState([], roleRows());
        const next = assignSelectedRole(state);
        expect(next).toBe(state);
    });
});

describe('clearSelectedRole', () => {
    it('sets the focused role assignment to undefined', () => {
        const rows = roleRows({ default: selection('p1', 'm1') });
        const state = createModelsOverlayState(ENTRIES, rows);
        expect(state.roleRows[0]?.assignment).toEqual(selection('p1', 'm1'));
        const cleared = clearSelectedRole(state);
        expect(cleared.roleRows[0]?.assignment).toBeUndefined();
    });

    it('does not mutate the input state', () => {
        const rows = roleRows({ default: selection('p1', 'm1') });
        const state = createModelsOverlayState(ENTRIES, rows);
        const before = state.roleRows[0]?.assignment;
        clearSelectedRole(state);
        expect(state.roleRows[0]?.assignment).toBe(before);
    });

    it('returns the input unchanged when the right column is empty', () => {
        const state = createModelsOverlayState(ENTRIES, []);
        const next = clearSelectedRole(state);
        expect(next).toBe(state);
    });
});

describe('createModelsOverlayView', () => {
    it('windows both columns with inclusive endIndex and correct totals', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const view = createModelsOverlayView(state, 5);
        expect(view.totalLeft).toBe(3);
        expect(view.totalRight).toBe(10);
        expect(view.startIndexLeft).toBe(0);
        expect(view.endIndexLeft).toBe(2);
        expect(view.leftVisible).toEqual(ENTRIES.slice(0, 3));
        expect(view.rightVisible).toHaveLength(5);
    });

    it('treats endIndex as an inclusive bound (slice start..end+1)', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const view = createModelsOverlayView(state, 2);
        expect(view.rightVisible).toHaveLength(2);
        expect(view.endIndexRight).toBe(view.startIndexRight + 1);
    });

    it('handles a long right column by centering the active index', () => {
        const scrolled = navigateModelsOverlayDown(
            switchModelsOverlayColumn(createModelsOverlayState(ENTRIES, roleRows())),
        );
        const view = createModelsOverlayView(scrolled, 3);
        expect(view.totalRight).toBe(10);
        expect(view.rightVisible).toHaveLength(3);
    });
});
