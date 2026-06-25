/** @jsxImportSource @opentui/react */
/**
 * Command palette overlay (T8).
 *
 * An Alt+X command palette that lists every reachable, non-hidden keymap
 * command PLUS the argument-less registry-slash commands (from slash-mapping),
 * lets the user filter and navigate, and dispatches the selected entry. It is
 * mounted inside `ChatKeymapProvider` (a sibling of ChatRoot, like T7's
 * `LeaderPendingCue`) so it always has a keymap in context and never contends
 * with the chat bridge — the plan forbids wiring this into
 * `opentui-chat-bridge.tsx` (T5/T6/T10-T15/T16 own the bridge).
 *
 * Self-contained via `useKeymap` + `registerLayer` (the task's suggested seam):
 *   - A toggle layer (always enabled) registers the `command.palette.show`
 *     command and binds Alt+X to it (the chord lives in keybind.ts as
 *     `command_list`; the id lives in `CommandMap.command_list`). The handler
 *     flips the open state.
 *   - A navigation layer (enabled only while open) binds Up/Down/Return/Escape
 *     to palette commands with `preventDefault` (the default), so those keys
 *     do not also drive the focused textarea while the palette is up.
 *
 * Free-text filtering rides opentui's global `useKeyboard` sink: while open,
 * single-character printable keys append to the query and Backspace pops it.
 * Navigation keys are intentionally ignored here (the nav layer owns them) so
 * there is no double-handling. T16 fixes the palette-open double-handle: a
 * shared `PaletteOpenContext` lets ChatRoot observe the open state and call
 * `key.preventDefault()` on printable keys while the palette is open, keeping
 * filter keystrokes off the focused textarea.
 *
 * The reachable-command list is derived reactively through
 * `useKeymapSelectorReact` with a STABLE module-level selector (the T1 store
 * captures the first selector at mount, so an inline arrow would never
 * re-derive). `getCommandEntries` allocates a fresh array per call; the store
 * memoizes by version so the snapshot stays referentially stable between state
 * signals (no `useSyncExternalStore` infinite loop).
 *
 * Not unit-rendered: apps/cli has no react-dom / react-test-renderer / DOM env
 * and this module imports `@opentui/react` (native FFI). Correctness of the
 * slash set is pinned by slash-mapping.test coverage; the live overlay is
 * exercised by the T18 tmux harness.
 */

import { useKeymap } from '@opentui/keymap/react';
import { useKeyboard } from '@opentui/react';
import type { MutableRefObject, ReactNode } from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toOpenTuiAttributes, toOpenTuiColor } from '../opentui-types.js';
import { CommandMap } from './keybind.js';
import type { OpenTuiKeymap } from './keymap-instance.js';
import { PaletteOpenContext } from './palette-open-context.js';
import { getPaletteSlashCommands, type PaletteSlashEntry } from './slash-mapping.js';
import { useKeymapSelectorReact } from './use-keymap-selector.js';

/** The palette toggle command id (mirrors `CommandMap.command_list`). */
const PALETTE_COMMAND_ID: string = CommandMap.command_list;

/** The palette toggle chord (mirrors `Definitions.command_list` = `alt+x`). */
const PALETTE_TOGGLE_KEY = 'alt+x';

/** Maximum rows rendered in the palette list window. */
const PALETTE_VISIBLE_ROWS = 10;

/** Single-char printable filter alphabet (letters + digits). */
const PRINTABLE_FILTER = /^[a-z0-9]$/;

const noopSetOpen = (): void => {};

/** A reachable keymap command projected to a palette row. */
interface PaletteKeymapItem {
    readonly kind: 'keymap';
    readonly name: string;
    readonly title: string;
    readonly description: string;
}

/** One row in the palette list: either a keymap command or a slash command. */
export type PaletteListItem =
    | { readonly kind: 'keymap'; readonly name: string; readonly title: string; readonly description: string }
    | { readonly kind: 'slash'; readonly slashName: string; readonly display: string; readonly description: string };

const EMPTY_LIST: readonly PaletteListItem[] = [];

/**
 * Declared-property view over a keymap `Command`'s display metadata. `Command`
 * exposes `hidden`/`title`/`desc` via its index signature, so reading them
 * directly trips `noPropertyAccessFromIndexSignature` (dot) or Biome's
 * `useLiteralKeys` (bracket). Narrowing to this declared shape lets both dot
 * access pass. `name` is included because `Command` declares it, which gives
 * the assertion a common declared property (without it TS rejects the cast as
 * "no properties in common").
 */
interface CommandDisplayMeta {
    readonly name: string;
    readonly hidden?: unknown;
    readonly title?: unknown;
    readonly desc?: unknown;
}

/**
 * STABLE module-level selector for the reachable, non-hidden keymap commands.
 * Passed to `useKeymapSelectorReact` once at mount. Excludes the palette toggle
 * command itself (no "open palette" row inside the palette) and any command
 * marked `hidden`.
 */
function selectReachablePaletteCommands(km: OpenTuiKeymap): readonly PaletteKeymapItem[] {
    const entries = km.getCommandEntries({ visibility: 'reachable' });
    const items: PaletteKeymapItem[] = [];
    for (const entry of entries) {
        const meta = entry.command as CommandDisplayMeta;
        if (meta.hidden === true) continue;
        if (meta.name === PALETTE_COMMAND_ID) continue;
        const title = meta.title;
        const desc = meta.desc;
        items.push({
            kind: 'keymap',
            name: meta.name,
            title: typeof title === 'string' ? title : meta.name,
            description: typeof desc === 'string' ? desc : '',
        });
    }
    return items;
}

/** Merge keymap commands with the registry-slash entries into one list. */
export function buildPaletteItems(
    keymapItems: readonly PaletteKeymapItem[],
    slashEntries: readonly PaletteSlashEntry[],
): readonly PaletteListItem[] {
    const slashItems: PaletteListItem[] = slashEntries.map((entry) => ({
        kind: 'slash',
        slashName: entry.slashName,
        display: entry.display,
        description: entry.description,
    }));
    return [...keymapItems, ...slashItems];
}

/** Case-insensitive substring filter over a palette item's searchable text. */
export function filterPaletteItems(items: readonly PaletteListItem[], query: string): readonly PaletteListItem[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter((item) => searchableText(item).includes(needle));
}

function searchableText(item: PaletteListItem): string {
    switch (item.kind) {
        case 'keymap':
            return `${item.title} ${item.description} ${item.name}`.toLowerCase();
        case 'slash':
            return `${item.display} ${item.description}`.toLowerCase();
    }
}

export interface CommandPaletteOverlayProps {
    /**
     * Invoked when the user selects a registry-slash entry. The bridge (T10)
     * wires this to the chat input / parseChatLine path; until then it is
     * optional and the palette simply closes on slash selection.
     */
    readonly onSelectSlash?: (slashName: string) => void;
}

/**
 * The live controller state the once-registered keymap command handlers close
 * over: the keymap, the open/selection setters, and refs mirroring the current
 * filtered list / selection / slash callback. Bundling them keeps the handler
 * signatures small and centralizes what would otherwise be 4-5 loose params.
 */
interface PaletteController {
    readonly keymap: OpenTuiKeymap;
    readonly setOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
    readonly setSelected: (value: number | ((prev: number) => number)) => void;
    readonly filteredRef: MutableRefObject<readonly PaletteListItem[]>;
    readonly selectedRef: MutableRefObject<number>;
    readonly onSelectSlashRef: MutableRefObject<((slashName: string) => void) | undefined>;
}

export function CommandPaletteOverlay({ onSelectSlash }: CommandPaletteOverlayProps): ReactNode {
    const keymap = useKeymap();
    const keymapCommands = useKeymapSelectorReact(selectReachablePaletteCommands);

    const paletteState = useContext(PaletteOpenContext);
    const open = paletteState !== null && paletteState.open;
    const setOpen = paletteState?.setOpen ?? noopSetOpen;

    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);

    const openRef = useRef(false);
    const filteredRef = useRef<readonly PaletteListItem[]>(EMPTY_LIST);
    const selectedRef = useRef(0);
    const onSelectSlashRef = useRef<typeof onSelectSlash>(onSelectSlash);
    useEffect(() => {
        openRef.current = open;
    }, [open]);
    useEffect(() => {
        onSelectSlashRef.current = onSelectSlash;
    }, [onSelectSlash]);

    const controller: PaletteController = useMemo(
        () => ({ keymap, setOpen, setSelected, filteredRef, selectedRef, onSelectSlashRef }),
        [keymap, setOpen],
    );

    // Register the toggle + navigation layers once per keymap. The nav layer's
    // `enabled` reads `openRef.current` live, so it is only active while the
    // palette is open (its bindings carry preventDefault by default, keeping
    // Up/Down/Return/Escape off the focused textarea while open).
    useEffect(() => {
        const offToggle = keymap.registerLayer({
            enabled: () => true,
            commands: [{ name: PALETTE_COMMAND_ID, run: () => toggleOpen(controller) }],
            bindings: [{ key: PALETTE_TOGGLE_KEY, cmd: PALETTE_COMMAND_ID }],
        });
        const offNav = keymap.registerLayer({
            enabled: () => openRef.current,
            commands: [
                { name: 'palette.nav.up', run: () => moveSelection(controller, -1) },
                { name: 'palette.nav.down', run: () => moveSelection(controller, 1) },
                { name: 'palette.nav.submit', run: () => submitSelection(controller) },
                { name: 'palette.nav.close', run: () => closePalette(controller) },
            ],
            bindings: [
                { key: 'up', cmd: 'palette.nav.up' },
                { key: 'down', cmd: 'palette.nav.down' },
                { key: 'return', cmd: 'palette.nav.submit' },
                { key: 'escape', cmd: 'palette.nav.close' },
            ],
        });
        return () => {
            offNav();
            offToggle();
        };
    }, [keymap, controller]);

    // Reset the filter + selection each time the palette opens.
    useEffect(() => {
        if (open) {
            setQuery('');
            setSelected(0);
        }
    }, [open]);

    const items = useMemo(() => buildPaletteItems(keymapCommands, getPaletteSlashCommands()), [keymapCommands]);
    const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);
    const clampedSelected = filtered.length === 0 ? 0 : Math.min(selected, filtered.length - 1);
    useEffect(() => {
        filteredRef.current = filtered;
    }, [filtered]);
    useEffect(() => {
        selectedRef.current = clampedSelected;
    }, [clampedSelected]);

    // Free-text filter via the global keyboard sink. Nav keys are ignored here
    // (the nav layer owns them) to avoid double-handling.
    useKeyboard(
        useCallback((key: { readonly name: string }) => {
            if (!openRef.current) return;
            const name = key.name;
            if (name === 'backspace') {
                setQuery((value) => value.slice(0, -1));
                return;
            }
            if (name.length === 1 && PRINTABLE_FILTER.test(name)) {
                setQuery((value) => value + name);
            }
        }, []),
    );

    if (!open) return null;
    return <PaletteWindow items={filtered} selected={clampedSelected} query={query} />;
}

function toggleOpen(controller: PaletteController): boolean {
    controller.setOpen((value) => !value);
    return true;
}

function moveSelection(controller: PaletteController, delta: number): boolean {
    const max = Math.max(0, controller.filteredRef.current.length - 1);
    controller.setSelected((value) => Math.min(max, Math.max(0, value + delta)));
    return true;
}

function closePalette(controller: PaletteController): boolean {
    controller.setOpen(false);
    return true;
}

function submitSelection(controller: PaletteController): boolean {
    const item = controller.filteredRef.current[controller.selectedRef.current];
    if (item !== undefined) {
        switch (item.kind) {
            case 'keymap':
                controller.keymap.dispatchCommand(item.name);
                break;
            case 'slash':
                controller.onSelectSlashRef.current?.(item.slashName);
                break;
        }
    }
    controller.setOpen(false);
    return true;
}

function PaletteWindow(props: {
    readonly items: readonly PaletteListItem[];
    readonly selected: number;
    readonly query: string;
}): ReactNode {
    const { items, selected, query } = props;
    const startIndex = Math.min(
        Math.max(0, selected - Math.floor(PALETTE_VISIBLE_ROWS / 2)),
        Math.max(0, items.length - PALETTE_VISIBLE_ROWS),
    );
    const visible = items.slice(startIndex, startIndex + PALETTE_VISIBLE_ROWS);

    const headerFg = toOpenTuiColor('cyan');
    const dimAttrs = toOpenTuiAttributes({ dimColor: true });
    const selectedAttrs = toOpenTuiAttributes({ inverse: true });
    const borderColor = toOpenTuiColor('gray');

    const rows: ReactNode[] = [];
    if (items.length === 0) {
        rows.push(<text key="empty" {...dimAttrs}>{`  no commands match "${query}"`}</text>);
    }
    for (let index = 0; index < visible.length; index += 1) {
        const item = visible[index];
        if (item === undefined) continue;
        const isSelected = startIndex + index === selected;
        const marker = isSelected ? '>' : ' ';
        const label = item.kind === 'keymap' ? item.title : item.display;
        const row = `${marker} ${label}`;
        rows.push(
            <text key={`${item.kind}:${startIndex + index}`} {...(isSelected ? selectedAttrs : dimAttrs)}>
                {row}
            </text>,
        );
    }

    return (
        <box
            position="absolute"
            top={1}
            left={2}
            right={2}
            flexDirection="column"
            {...(borderColor !== undefined ? { borderStyle: 'single', borderColor } : { borderStyle: 'single' })}
        >
            <text {...(headerFg !== undefined ? { fg: headerFg } : {})} {...dimAttrs}>
                {`Commands${query.length > 0 ? ` matching "${query}"` : ''}  (Alt+X/Esc to close)`}
            </text>
            {rows}
        </box>
    );
}
