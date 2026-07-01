import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    assignSelectedRole,
    clearSelectedRole,
    computeProviderTabs,
    createModelsOverlayRoleRows,
    createModelsOverlayState,
    createModelsOverlayView,
    filterLeftEntries,
    formatModelSelection,
    formatProviderTabLabel,
    formatRoleFallback,
    type ModelsOverlayRoleRow,
    navigateModelsOverlayDown,
    navigateModelsOverlayUp,
    setModelsOverlayProviderTab,
    setModelsOverlaySearchQuery,
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

describe('createModelsOverlayState defaults', () => {
    it('defaults searchQuery to empty and activeProviderTab to all', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        expect(state.searchQuery).toBe('');
        expect(state.activeProviderTab).toBe('all');
    });

    it('accepts optional initial searchQuery and activeProviderTab', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows(), {
            searchQuery: 'sonnet',
            activeProviderTab: 'p1',
        });
        expect(state.searchQuery).toBe('sonnet');
        expect(state.activeProviderTab).toBe('p1');
    });
});

describe('formatModelSelection', () => {
    it('formats provider/model without a variant', () => {
        expect(formatModelSelection(selection('anthropic', 'claude-4'))).toBe('anthropic/claude-4');
    });

    it('appends the variant as #suffix', () => {
        expect(formatModelSelection(selection('anthropic', 'claude-4', 'thinking-high'))).toBe(
            'anthropic/claude-4#thinking-high',
        );
    });
});

describe('formatProviderTabLabel', () => {
    it('uppercases a simple providerID', () => {
        expect(formatProviderTabLabel('anthropic')).toBe('ANTHROPIC');
    });

    it('replaces hyphens and underscores with spaces', () => {
        expect(formatProviderTabLabel('zai-coding-plan')).toBe('ZAI CODING PLAN');
        expect(formatProviderTabLabel('github_copilot')).toBe('GITHUB COPILOT');
    });
});

describe('computeProviderTabs', () => {
    it('always returns ALL as the first tab', () => {
        const tabs = computeProviderTabs([]);
        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toEqual({ id: 'all', label: 'ALL' });
    });

    it('deduplicates providers and sorts them alphabetically', () => {
        const entries = [
            selection('zai-coding-plan', 'glm-5'),
            selection('anthropic', 'claude-4'),
            selection('anthropic', 'claude-3'),
            selection('openai', 'gpt-5'),
        ];
        const tabs = computeProviderTabs(entries);
        expect(tabs.map((t) => t.id)).toEqual(['all', 'anthropic', 'openai', 'zai-coding-plan']);
        expect(tabs.map((t) => t.label)).toEqual(['ALL', 'ANTHROPIC', 'OPENAI', 'ZAI CODING PLAN']);
    });
});

describe('filterLeftEntries', () => {
    const FILTER_ENTRIES = [
        selection('anthropic', 'claude-sonnet-4'),
        selection('anthropic', 'claude-haiku'),
        selection('openai', 'gpt-5'),
        selection('openai', 'gpt-5', 'reasoning-high'),
    ] as const;

    it('returns all entries when tab is all and query is empty', () => {
        expect(filterLeftEntries(FILTER_ENTRIES, 'all', '')).toEqual([...FILTER_ENTRIES]);
    });

    it('filters to a single provider when activeProviderTab is set', () => {
        const filtered = filterLeftEntries(FILTER_ENTRIES, 'anthropic', '');
        expect(filtered).toHaveLength(2);
        expect(filtered.every((e) => e.providerID === 'anthropic')).toBe(true);
    });

    it('filters by case-insensitive search query across all providers', () => {
        const filtered = filterLeftEntries(FILTER_ENTRIES, 'all', 'sonnet');
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.modelID).toBe('claude-sonnet-4');
    });

    it('composes provider tab AND search query', () => {
        const filtered = filterLeftEntries(FILTER_ENTRIES, 'openai', 'reasoning');
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.variantID).toBe('reasoning-high');
    });

    it('matches the #variant suffix in the search string', () => {
        const filtered = filterLeftEntries(FILTER_ENTRIES, 'all', '#reasoning-high');
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.modelID).toBe('gpt-5');
    });

    it('returns an empty array when nothing matches', () => {
        expect(filterLeftEntries(FILTER_ENTRIES, 'all', 'zzz')).toEqual([]);
    });
});

describe('setModelsOverlaySearchQuery', () => {
    it('sets the query and resets activeLeftIndex to 0', () => {
        const downOnce = navigateModelsOverlayDown(createModelsOverlayState(ENTRIES, roleRows()));
        expect(downOnce.activeLeftIndex).toBe(1);
        const next = setModelsOverlaySearchQuery(downOnce, 'sonnet');
        expect(next.searchQuery).toBe('sonnet');
        expect(next.activeLeftIndex).toBe(0);
    });

    it('does not mutate the input state', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const next = setModelsOverlaySearchQuery(state, 'x');
        expect(state.searchQuery).toBe('');
        expect(next).not.toBe(state);
    });
});

describe('setModelsOverlayProviderTab', () => {
    it('sets the tab and resets activeLeftIndex to 0', () => {
        const downOnce = navigateModelsOverlayDown(createModelsOverlayState(ENTRIES, roleRows()));
        expect(downOnce.activeLeftIndex).toBe(1);
        const next = setModelsOverlayProviderTab(downOnce, 'p1');
        expect(next.activeProviderTab).toBe('p1');
        expect(next.activeLeftIndex).toBe(0);
    });

    it('does not mutate the input state', () => {
        const state = createModelsOverlayState(ENTRIES, roleRows());
        const next = setModelsOverlayProviderTab(state, 'p1');
        expect(state.activeProviderTab).toBe('all');
        expect(next).not.toBe(state);
    });
});

describe('createModelsOverlayView with filtering', () => {
    const FILTER_ENTRIES = [
        selection('anthropic', 'claude-sonnet-4'),
        selection('anthropic', 'claude-haiku'),
        selection('openai', 'gpt-5'),
    ] as const;

    it('exposes providerTabs computed from leftEntries', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows());
        const view = createModelsOverlayView(state, 5);
        expect(view.providerTabs.map((t) => t.id)).toEqual(['all', 'anthropic', 'openai']);
        expect(view.activeProviderTab).toBe('all');
        expect(view.searchQuery).toBe('');
    });

    it('totalLeft reflects the filtered count when a provider tab is active', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { activeProviderTab: 'anthropic' });
        const view = createModelsOverlayView(state, 5);
        expect(view.totalLeft).toBe(2);
        expect(view.filteredLeftCount).toBe(2);
        expect(view.leftVisible.every((e) => e.providerID === 'anthropic')).toBe(true);
    });

    it('totalLeft reflects the filtered count when a search query is active', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { searchQuery: 'sonnet' });
        const view = createModelsOverlayView(state, 5);
        expect(view.totalLeft).toBe(1);
        expect(view.leftVisible[0]?.modelID).toBe('claude-sonnet-4');
    });

    it('leftVisible is empty and totalLeft is 0 when nothing matches', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { searchQuery: 'zzz' });
        const view = createModelsOverlayView(state, 5);
        expect(view.totalLeft).toBe(0);
        expect(view.leftVisible).toEqual([]);
    });
});

describe('assignSelectedRole with filtering', () => {
    const FILTER_ENTRIES = [selection('anthropic', 'claude-sonnet-4'), selection('openai', 'gpt-5')] as const;

    it('assigns from the filtered list when a provider tab is active', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { activeProviderTab: 'anthropic' });
        const assigned = assignSelectedRole(state);
        expect(assigned.roleRows[0]?.assignment).toEqual(selection('anthropic', 'claude-sonnet-4'));
    });

    it('returns the input unchanged when the filtered list is empty', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { searchQuery: 'zzz' });
        const next = assignSelectedRole(state);
        expect(next).toBe(state);
    });
});

describe('navigation with filtering', () => {
    const FILTER_ENTRIES = [
        selection('anthropic', 'claude-sonnet-4'),
        selection('anthropic', 'claude-haiku'),
        selection('openai', 'gpt-5'),
    ] as const;

    it('clamps activeLeftIndex to the filtered count', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { activeProviderTab: 'anthropic' });
        const filteredCount = 2;
        let navigated = state;
        for (let i = 0; i < filteredCount + 5; i++) {
            navigated = navigateModelsOverlayDown(navigated);
        }
        expect(navigated.activeLeftIndex).toBe(filteredCount - 1);
    });

    it('is a no-op returning the same reference when the filtered list is empty', () => {
        const state = createModelsOverlayState(FILTER_ENTRIES, roleRows(), { searchQuery: 'zzz' });
        const next = navigateModelsOverlayDown(state);
        expect(next).toBe(state);
        expect(next.activeLeftIndex).toBe(0);
    });
});
