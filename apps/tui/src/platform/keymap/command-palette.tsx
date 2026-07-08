/** @jsxImportSource @opentui/solid */
/**
 * Command palette overlay (T8).
 *
 * An Alt+X command palette that lists every reachable, non-hidden keymap
 * command PLUS the argument-less registry-slash commands (from slash-mapping),
 * lets the user filter and navigate, and dispatches the selected entry. It is
 * mounted inside `ChatKeymapProvider` (a sibling of ChatRoot, like T7's
 * `LeaderPendingCue`) so it always has a keymap in context and never contends
 * with chat-store state.
 *
 * Self-contained via `useKeymap` + Solid `useBindings`:
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
 * The reachable-command list is derived reactively through Solid's native
 * `useKeymapSelector` accessor with a stable module-level selector.
 *
 * Not unit-rendered: the TUI has no DOM test environment
 * and this module renders OpenTUI intrinsics. Correctness of the slash set is
 * pinned by slash-mapping.test coverage; the live overlay is exercised by the
 * T18 tmux harness.
 */

import { TextAttributes } from '@opentui/core';
import { reactiveMatcherFromSignal, useBindings, useKeymap, useKeymapSelector } from '@opentui/keymap/solid';
import { useKeyboard } from '@opentui/solid';
import {
    type Accessor,
    createEffect,
    createMemo,
    createSignal,
    For,
    type JSX,
    type Setter,
    Show,
    useContext,
} from 'solid-js';
import { CommandMap } from './keybind.js';
import type { OpenTuiKeymap } from './keymap-instance.js';
import { PaletteOpenContext } from './palette-open-context.js';
import { getPaletteSlashCommands, type PaletteSlashEntry } from './slash-mapping.js';

/** The palette toggle command id (mirrors `CommandMap.command_list`). */
const PALETTE_COMMAND_ID: string = CommandMap.command_list;

/** The palette toggle chord (mirrors `Definitions.command_list` = `alt+x`). */
const PALETTE_TOGGLE_KEY = 'alt+x';

/** Maximum rows rendered in the palette list window. */
const PALETTE_VISIBLE_ROWS = 10;

/** Single-char printable filter alphabet (letters + digits). */
const PRINTABLE_FILTER = /^[a-z0-9]$/;

const noopSetOpen: Setter<boolean> = (value) => (typeof value === 'function' ? value(false) : value);

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
 * Passed to `useKeymapSelector` once at mount. Excludes the palette toggle
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
     * Invoked when the user selects a registry-slash entry. The chat runtime (T10)
     * wires this to the chat input / parseChatLine path; until then it is
     * optional and the palette simply closes on slash selection.
     */
    readonly onSelectSlash?: (slashName: string) => void;
}

/**
 * The live controller state the registered keymap command handlers close over.
 */
interface PaletteController {
    readonly keymap: OpenTuiKeymap;
    readonly setOpen: Setter<boolean>;
    readonly setSelected: Setter<number>;
    readonly filtered: Accessor<readonly PaletteListItem[]>;
    readonly selected: Accessor<number>;
    readonly onSelectSlash: () => ((slashName: string) => void) | undefined;
}

export function CommandPaletteOverlay(props: CommandPaletteOverlayProps): JSX.Element {
    const keymap = useKeymap();
    const keymapCommands = useKeymapSelector(selectReachablePaletteCommands);

    const paletteState = useContext(PaletteOpenContext);
    const open = (): boolean => paletteState?.open() ?? false;
    const setOpen = paletteState?.setOpen ?? noopSetOpen;

    const [query, setQuery] = createSignal('');
    const [selected, setSelected] = createSignal(0);

    const items = createMemo(() => buildPaletteItems(keymapCommands(), getPaletteSlashCommands()));
    const filtered = createMemo(() => filterPaletteItems(items(), query()));
    const clampedSelected = createMemo(() => {
        const visible = filtered();
        return visible.length === 0 ? 0 : Math.min(selected(), visible.length - 1);
    });

    const controller: PaletteController = {
        keymap,
        setOpen,
        setSelected,
        filtered,
        selected: clampedSelected,
        onSelectSlash: () => props.onSelectSlash,
    };

    useBindings(() => ({
        enabled: () => true,
        commands: [{ name: PALETTE_COMMAND_ID, run: () => toggleOpen(controller) }],
        bindings: [{ key: PALETTE_TOGGLE_KEY, cmd: PALETTE_COMMAND_ID }],
    }));

    useBindings(() => ({
        enabled: reactiveMatcherFromSignal(open),
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
    }));

    createEffect(() => {
        if (open()) {
            setQuery('');
            setSelected(0);
        }
    });

    useKeyboard((key: { readonly name: string }) => {
        if (!open()) return;
        const name = key.name;
        if (name === 'backspace') {
            setQuery((value) => value.slice(0, -1));
            return;
        }
        if (name.length === 1 && PRINTABLE_FILTER.test(name)) {
            setQuery((value) => value + name);
        }
    });

    return (
        <Show when={open()}>
            <PaletteWindow items={filtered()} selected={clampedSelected()} query={query()} />
        </Show>
    );
}

function toggleOpen(controller: PaletteController): boolean {
    controller.setOpen((value) => !value);
    return true;
}

function moveSelection(controller: PaletteController, delta: number): boolean {
    const max = Math.max(0, controller.filtered().length - 1);
    controller.setSelected((value) => Math.min(max, Math.max(0, value + delta)));
    return true;
}

function closePalette(controller: PaletteController): boolean {
    controller.setOpen(false);
    return true;
}

function submitSelection(controller: PaletteController): boolean {
    const item = controller.filtered()[controller.selected()];
    if (item !== undefined) {
        switch (item.kind) {
            case 'keymap':
                controller.keymap.dispatchCommand(item.name);
                break;
            case 'slash':
                controller.onSelectSlash()?.(item.slashName);
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
}): JSX.Element {
    const startIndex = createMemo(() =>
        Math.min(
            Math.max(0, props.selected - Math.floor(PALETTE_VISIBLE_ROWS / 2)),
            Math.max(0, props.items.length - PALETTE_VISIBLE_ROWS),
        ),
    );
    const visible = createMemo(() => props.items.slice(startIndex(), startIndex() + PALETTE_VISIBLE_ROWS));

    const headerFg = '#00ffff';
    const borderColor = '#808080';

    return (
        <box
            position="absolute"
            top={1}
            left={2}
            right={2}
            flexDirection="column"
            borderStyle="single"
            borderColor={borderColor}
        >
            <text fg={headerFg} attributes={TextAttributes.DIM}>
                {`Commands${props.query.length > 0 ? ` matching "${props.query}"` : ''}  (Alt+X/Esc to close)`}
            </text>
            <Show when={props.items.length === 0}>
                <text attributes={TextAttributes.DIM}>{`  no commands match "${props.query}"`}</text>
            </Show>
            <For each={visible()}>
                {(item, index) => {
                    const rowIndex = (): number => startIndex() + index();
                    const isSelected = (): boolean => rowIndex() === props.selected;
                    const label = item.kind === 'keymap' ? item.title : item.display;
                    return (
                        <text attributes={isSelected() ? TextAttributes.INVERSE : TextAttributes.DIM}>
                            {`${isSelected() ? '>' : ' '} ${label}`}
                        </text>
                    );
                }}
            </For>
        </box>
    );
}
