/**
 * `@path` file-attachment autocomplete state machine for the interactive TUI.
 *
 * Mirrors the slash-command menu (`interactive-chat-command-menu.ts`): a pure
 * state value plus helpers that the Ink bridge calls from `handleInput`. The
 * bridge detects an active `@<prefix>` at the end of the input buffer, calls
 * `updateFileAutocomplete` to list matching entries from the workspace root,
 * renders the popup via `createFileAutocompleteView`, and resolves Tab/Enter
 * completion through `buildFileAutocompleteCompletion`.
 *
 * Path completion only — the model sees the resulting `@path` reference as a
 * hint and can use `repo.read` itself. Files are never auto-read here.
 *
 * Denylist is aligned with `packages/core`'s
 * `defaultReadOnlyRepoToolDenylist` (`temp/ref-repos`, `.omo/evidence`, `.nx`,
 * `dist`, `build`, `target`, `coverage`, `node_modules`, `.git`) and extended
 * with `.omo` so the whole agent-state dir stays hidden from the picker.
 */

import { type Dirent, readdirSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';

export type FileMatch = {
    readonly name: string;
    readonly isDirectory: boolean;
};

export type FileAutocompleteState = {
    readonly open: boolean;
    readonly prefix: string;
    readonly matches: readonly FileMatch[];
    readonly selectedIndex: number;
};

export type FileAutocompleteView = {
    readonly open: boolean;
    readonly prefix: string;
    readonly selectedIndex: number;
    readonly startIndex: number;
    readonly totalCount: number;
    readonly visibleMatches: readonly FileMatch[];
    readonly empty: boolean;
};

const deniedPathEntries = [
    'node_modules',
    '.git',
    '.nx',
    '.omo',
    'dist',
    'build',
    'target',
    'coverage',
    'temp/ref-repos',
] as const;

const whitespacePattern = /\s/u;
const maxReturnedMatches = 100;

export function createFileAutocompleteState(): FileAutocompleteState {
    return { open: false, prefix: '', matches: [], selectedIndex: 0 };
}

export function updateFileAutocomplete(
    state: FileAutocompleteState,
    prefix: string,
    workspaceRoot: string,
): FileAutocompleteState {
    if (whitespacePattern.test(prefix)) {
        return createFileAutocompleteState();
    }
    const matches = listMatchingEntries(prefix, workspaceRoot);
    const selectedIndex = state.selectedIndex >= matches.length ? 0 : state.selectedIndex;
    return {
        open: true,
        prefix,
        matches,
        selectedIndex,
    };
}

export function navigateFileAutocompleteUp(state: FileAutocompleteState): FileAutocompleteState {
    if (!state.open || state.matches.length === 0) {
        return state;
    }
    const total = state.matches.length;
    return { ...state, selectedIndex: (state.selectedIndex - 1 + total) % total };
}

export function navigateFileAutocompleteDown(state: FileAutocompleteState): FileAutocompleteState {
    if (!state.open || state.matches.length === 0) {
        return state;
    }
    const total = state.matches.length;
    return { ...state, selectedIndex: (state.selectedIndex + 1) % total };
}

export function resolveFileAutocomplete(state: FileAutocompleteState): string | undefined {
    if (!state.open || state.matches.length === 0) {
        return undefined;
    }
    const clamped = Math.min(Math.max(state.selectedIndex, 0), state.matches.length - 1);
    return state.matches[clamped]?.name;
}

/**
 * Build the full replacement path (`<dirPart><entryName>`, plus a trailing `/`
 * for directories) so the bridge can splice `@prefix` -> `@path` in one step.
 * Returns undefined when no match is selectable.
 */
export function buildFileAutocompleteCompletion(state: FileAutocompleteState): string | undefined {
    if (!state.open || state.matches.length === 0) {
        return undefined;
    }
    const clamped = Math.min(Math.max(state.selectedIndex, 0), state.matches.length - 1);
    const match = state.matches[clamped];
    if (match === undefined) {
        return undefined;
    }
    const slashIndex = state.prefix.lastIndexOf('/');
    const dirPart = slashIndex === -1 ? '' : state.prefix.slice(0, slashIndex + 1);
    const suffix = match.isDirectory ? '/' : '';
    return `${dirPart}${match.name}${suffix}`;
}

export function createFileAutocompleteView(
    state: FileAutocompleteState,
    maxVisibleChoices: number,
): FileAutocompleteView {
    if (!state.open) {
        return {
            open: false,
            prefix: '',
            selectedIndex: 0,
            startIndex: 0,
            totalCount: 0,
            visibleMatches: [],
            empty: false,
        };
    }
    const totalCount = state.matches.length;
    const visibleLimit = Math.max(1, maxVisibleChoices);
    const selectedIndex = clampSelection(state.selectedIndex, totalCount);
    const startIndex = getWindowStartIndex(selectedIndex, totalCount, visibleLimit);
    return {
        open: true,
        prefix: state.prefix,
        selectedIndex,
        startIndex,
        totalCount,
        visibleMatches: state.matches.slice(startIndex, startIndex + visibleLimit),
        empty: totalCount === 0,
    };
}

function listMatchingEntries(prefix: string, workspaceRoot: string): readonly FileMatch[] {
    const { directoryRelative, nameFilter } = splitPrefix(prefix);
    const rootAbsolute = resolve(workspaceRoot);
    const directoryAbsolute = resolve(rootAbsolute, directoryRelative);
    if (!containsPath(rootAbsolute, directoryAbsolute)) {
        return [];
    }
    let entries: readonly Dirent[];
    try {
        entries = readdirSync(directoryAbsolute, { withFileTypes: true });
    } catch {
        return [];
    }
    const matches: FileMatch[] = [];
    for (const entry of entries) {
        const name = entry.name;
        if (name === '.' || name === '..' || !name.startsWith(nameFilter)) {
            continue;
        }
        const entryRelativePath =
            directoryRelative.length === 0 ? name : `${posixNormalize(directoryRelative)}/${name}`;
        if (isDeniedRelativePath(entryRelativePath)) {
            continue;
        }
        matches.push({ name, isDirectory: entry.isDirectory() });
        if (matches.length >= maxReturnedMatches) {
            break;
        }
    }
    matches.sort(compareFileMatches);
    return matches;
}

function compareFileMatches(a: FileMatch, b: FileMatch): number {
    if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
    }
    if (a.name < b.name) {
        return -1;
    }
    if (a.name > b.name) {
        return 1;
    }
    return 0;
}

function splitPrefix(prefix: string): { readonly directoryRelative: string; readonly nameFilter: string } {
    const slashIndex = prefix.lastIndexOf('/');
    if (slashIndex === -1) {
        return { directoryRelative: '', nameFilter: prefix };
    }
    const directoryRelative = posixNormalize(prefix.slice(0, slashIndex + 1)).replace(/\/+$/u, '');
    const nameFilter = prefix.slice(slashIndex + 1);
    return { directoryRelative, nameFilter };
}

function posixNormalize(path: string): string {
    return posix.normalize(path.split('\\').join('/'));
}

function isDeniedRelativePath(relativePath: string): boolean {
    const canonical = canonicalPolicyPath(relativePath);
    return deniedPathEntries.some((entry) => matchesDenylistEntry(canonicalPolicyPath(entry), canonical));
}

function matchesDenylistEntry(entry: string, relativePath: string): boolean {
    if (entry.includes('/')) {
        return entry === '.' || relativePath === entry || relativePath.startsWith(`${entry}/`);
    }
    return relativePath.split('/').includes(entry);
}

function canonicalPolicyPath(path: string): string {
    const normalized = path
        .split('\\')
        .join('/')
        .split('/')
        .filter((segment) => segment.length > 0)
        .join('/')
        .toLowerCase();
    return normalized.length === 0 ? '.' : normalized;
}

function containsPath(root: string, target: string): boolean {
    if (isAbsolute(root) !== isAbsolute(target)) {
        return false;
    }
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function clampSelection(selectedIndex: number, totalCount: number): number {
    if (totalCount <= 0) {
        return 0;
    }
    return Math.min(Math.max(selectedIndex, 0), totalCount - 1);
}

function getWindowStartIndex(selectedIndex: number, totalCount: number, visibleLimit: number): number {
    if (totalCount <= visibleLimit) {
        return 0;
    }
    const halfWindow = Math.floor(visibleLimit / 2);
    return Math.min(Math.max(selectedIndex - halfWindow, 0), totalCount - visibleLimit);
}
