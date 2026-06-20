import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildFileAutocompleteCompletion,
    createFileAutocompleteState,
    createFileAutocompleteView,
    type FileAutocompleteState,
    navigateFileAutocompleteDown,
    navigateFileAutocompleteUp,
    resolveFileAutocomplete,
    updateFileAutocomplete,
} from './interactive-chat-file-autocomplete.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

function findMatchNames(state: FileAutocompleteState): readonly string[] {
    return state.matches.map((match) => match.name);
}

function hasMatch(state: FileAutocompleteState, name: string): boolean {
    return state.matches.some((match) => match.name === name);
}

describe('interactive chat file autocomplete — createFileAutocompleteState', () => {
    it('starts closed and empty', () => {
        const state = createFileAutocompleteState();
        expect(state.open).toBe(false);
        expect(state.prefix).toBe('');
        expect(state.matches).toEqual([]);
        expect(state.selectedIndex).toBe(0);
    });
});

describe('interactive chat file autocomplete — updateFileAutocomplete against the workspace root', () => {
    it('matches the "packages" directory when prefix is "pack"', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'pack', repoRoot);
        expect(state.open).toBe(true);
        expect(state.prefix).toBe('pack');
        expect(hasMatch(state, 'packages')).toBe(true);
    });

    it('matches "core" inside packages/ when prefix is "packages/co"', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'packages/co', repoRoot);
        expect(state.open).toBe(true);
        expect(hasMatch(state, 'core')).toBe(true);
    });

    it('returns the directory marker for directory matches', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'pack', repoRoot);
        const packagesMatch = state.matches.find((match) => match.name === 'packages');
        expect(packagesMatch?.isDirectory).toBe(true);
    });

    it('keeps the selection index in range when the new match list is shorter', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'packages/co', repoRoot);
        state = navigateFileAutocompleteDown(state);
        const previousIndex = state.selectedIndex;
        state = updateFileAutocomplete(state, 'packages/cor', repoRoot);
        expect(state.selectedIndex).toBeLessThan(state.matches.length);
        expect(state.selectedIndex).not.toBe(previousIndex);
    });
});

describe('interactive chat file autocomplete — denylist', () => {
    it('never lists node_modules, .git at the workspace root', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), '', repoRoot);
        const names = findMatchNames(state);
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).not.toContain('.nx');
        expect(names).not.toContain('dist');
        expect(names).not.toContain('.omo');
    });

    it('never lists ref-repos inside temp/', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'temp/', repoRoot);
        const names = findMatchNames(state);
        expect(names).not.toContain('ref-repos');
    });

    it('still lists the non-denied temp/ parent directory at the root', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'tem', repoRoot);
        expect(hasMatch(state, 'temp')).toBe(true);
    });

    it('does not escape the workspace via a ../ prefix', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), '../', repoRoot);
        expect(state.matches).toEqual([]);
    });
});

describe('interactive chat file autocomplete — navigation', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mctrl-file-ac-'));
        mkdirSync(join(tempRoot, 'alpha'));
        mkdirSync(join(tempRoot, 'beta'));
        writeFileSync(join(tempRoot, 'gamma.txt'), 'x', 'utf-8');
    });

    afterEach(() => {
        // mkdtempSync output is under the OS tmp cleanup root; vitest leaves it.
        // No explicit rm needed for test correctness.
    });

    it('cycles down through matches and wraps around', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), '', tempRoot);
        expect(state.matches.length).toBeGreaterThanOrEqual(3);
        expect(state.selectedIndex).toBe(0);

        state = navigateFileAutocompleteDown(state);
        expect(state.selectedIndex).toBe(1);
        state = navigateFileAutocompleteDown(state);
        expect(state.selectedIndex).toBe(2);
        state = navigateFileAutocompleteDown(state);
        expect(state.selectedIndex).toBe(0);
    });

    it('cycles up through matches and wraps around', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), '', tempRoot);
        state = navigateFileAutocompleteUp(state);
        expect(state.selectedIndex).toBe(state.matches.length - 1);
        state = navigateFileAutocompleteUp(state);
        expect(state.selectedIndex).toBe(state.matches.length - 2);
    });

    it('is a no-op on a closed state', () => {
        const closed = createFileAutocompleteState();
        expect(navigateFileAutocompleteUp(closed)).toBe(closed);
        expect(navigateFileAutocompleteDown(closed)).toBe(closed);
    });

    it('is a no-op when there are no matches', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'zzzz-no-such', tempRoot);
        state = { ...state, open: true, matches: [] };
        expect(navigateFileAutocompleteUp(state).selectedIndex).toBe(0);
        expect(navigateFileAutocompleteDown(state).selectedIndex).toBe(0);
    });

    it('resolves the selected match name via resolveFileAutocomplete', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), '', tempRoot);
        state = navigateFileAutocompleteDown(state);
        const expected = state.matches[state.selectedIndex]?.name;
        expect(resolveFileAutocomplete(state)).toBe(expected);
    });

    it('returns undefined from resolveFileAutocomplete when closed or empty', () => {
        expect(resolveFileAutocomplete(createFileAutocompleteState())).toBeUndefined();
        const openEmpty: FileAutocompleteState = { open: true, prefix: '', matches: [], selectedIndex: 0 };
        expect(resolveFileAutocomplete(openEmpty)).toBeUndefined();
    });
});

describe('interactive chat file autocomplete — completion', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mctrl-file-ac-comp-'));
        mkdirSync(join(tempRoot, 'packages'));
        mkdirSync(join(tempRoot, 'packages', 'core'));
        writeFileSync(join(tempRoot, 'packages', 'core', 'index.ts'), 'x', 'utf-8');
        writeFileSync(join(tempRoot, 'readme.md'), 'x', 'utf-8');
    });

    it('builds a directory completion with a trailing slash for a top-level dir', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'pack', tempRoot);
        const packagesMatch = state.matches.find((match) => match.name === 'packages');
        expect(packagesMatch).toBeDefined();
        state = { ...state, selectedIndex: state.matches.indexOf(packagesMatch ?? state.matches[0]!) };
        expect(buildFileAutocompleteCompletion(state)).toBe('packages/');
    });

    it('builds a completion that preserves the dirPart for a nested entry', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'packages/co', tempRoot);
        const coreMatch = state.matches.find((match) => match.name === 'core');
        expect(coreMatch).toBeDefined();
        state = { ...state, selectedIndex: state.matches.indexOf(coreMatch ?? state.matches[0]!) };
        expect(buildFileAutocompleteCompletion(state)).toBe('packages/core/');
    });

    it('builds a file completion without a trailing slash', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'read', tempRoot);
        const readmeMatch = state.matches.find((match) => match.name === 'readme.md');
        expect(readmeMatch).toBeDefined();
        state = { ...state, selectedIndex: state.matches.indexOf(readmeMatch ?? state.matches[0]!) };
        expect(buildFileAutocompleteCompletion(state)).toBe('readme.md');
    });

    it('returns undefined when there are no matches', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'zzz', tempRoot);
        expect(buildFileAutocompleteCompletion(state)).toBeUndefined();
    });
});

describe('interactive chat file autocomplete — empty prefix shows top-level minus denied', () => {
    it('lists real top-level workspace entries but never denied ones', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), '', repoRoot);
        expect(state.open).toBe(true);
        expect(state.prefix).toBe('');
        expect(hasMatch(state, 'packages')).toBe(true);
        expect(hasMatch(state, 'apps')).toBe(true);
        expect(hasMatch(state, 'node_modules')).toBe(false);
        expect(hasMatch(state, '.git')).toBe(false);
        expect(hasMatch(state, 'temp')).toBe(true);
    });

    it('sorts directories first', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'pack', repoRoot);
        const first = state.matches[0];
        expect(first?.isDirectory).toBe(true);
    });
});

describe('interactive chat file autocomplete — view', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mctrl-file-ac-view-'));
        for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) {
            writeFileSync(join(tempRoot, `${name}.txt`), 'x', 'utf-8');
        }
    });

    it('returns a closed view when the state is closed', () => {
        const view = createFileAutocompleteView(createFileAutocompleteState(), 5);
        expect(view.open).toBe(false);
        expect(view.visibleMatches).toEqual([]);
        expect(view.totalCount).toBe(0);
    });

    it('windows the visible matches and keeps the selection in view', () => {
        let state = updateFileAutocomplete(createFileAutocompleteState(), 'a', tempRoot);
        expect(state.matches.length).toBeGreaterThanOrEqual(8);
        // move selection deep enough to force the window down
        for (let i = 0; i < 5; i += 1) {
            state = navigateFileAutocompleteDown(state);
        }
        const view = createFileAutocompleteView(state, 4);
        expect(view.open).toBe(true);
        expect(view.visibleMatches.length).toBeLessThanOrEqual(4);
        expect(view.selectedIndex).toBeGreaterThanOrEqual(view.startIndex);
        expect(view.selectedIndex).toBeLessThan(view.startIndex + view.visibleMatches.length);
        expect(view.totalCount).toBe(state.matches.length);
    });

    it('flags the empty state when no entries match', () => {
        const state = updateFileAutocomplete(createFileAutocompleteState(), 'zzz', tempRoot);
        const view = createFileAutocompleteView(state, 5);
        expect(view.open).toBe(true);
        expect(view.empty).toBe(true);
        expect(view.visibleMatches).toEqual([]);
    });
});
