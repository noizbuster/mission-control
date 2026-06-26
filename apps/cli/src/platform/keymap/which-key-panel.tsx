/** @jsxImportSource @opentui/react */
/**
 * Which-key panel overlay (T9).
 *
 * REBUILD (not copy) of opencode's SolidJS which-key
 * (tui/src/feature-plugins/system/which-key.tsx) for mctrl's React (opentui)
 * TUI. Ports ONLY:
 *   (a) base-mode binding display — a grouped list of the current mode's
 *       bindings with their chord + description,
 *   (b) toggle open/close on `Ctrl+Alt+K` (`which_key_toggle`),
 *   (c) dock/overlay layout switch on `Ctrl+Alt+Shift+K`
 *       (`which_key_layout_toggle`).
 *
 * OUT of scope (dropped from opencode, flagged here): key-discovery (pending-
 * sequence preview), column-config (multi-column adaptive layout), search/
 * filter, group tabs, scroll/page commands, and pending-sequence auto-show.
 * mctrl ships a single-column grouped list; the full adaptive panel is
 * deferred to a later todo.
 *
 * Self-contained via `useKeymap` + `registerLayer` (mirrors T8's palette): a
 * toggle layer registers `which-key.toggle` + `which-key.layout.toggle`
 * commands bound to the chords sourced from keybind.ts. The toggle flips
 * internal open state; the layout toggle flips dock/overlay. Mounted in
 * keymap-provider.tsx with absolute positioning (T7/T8 lesson) so it overlays
 * without disrupting ChatRoot.
 *
 * The binding list is derived reactively through `useKeymapSelectorReact` with
 * a STABLE module-level selector (`selectReachableEntries`). Mode filtering +
 * grouping happen in the pure `projectWhichKeyEntries` step driven by the
 * React mode-stack context, so the displayed set updates when an overlay
 * pushes a mode — without the selector closing over mode (which would bust
 * the T1 store's selector-identity cache).
 *
 * Pure helpers (`projectWhichKeyEntries`/`groupEntries`/`nextLayout`/
 * `formatSequence`) and `registerWhichKeyLayer` are exported so the
 * acceptance contract is unit-testable without a renderer. This module does
 * NOT import `@opentui/react` (the FFI main) — only `@opentui/keymap/react`
 * (FFI-free) and the jsx-runtime (via the pragma, a one-line react
 * re-export) — so importing its pure helpers is FFI-safe in tests.
 */

import type { Keymap, KeymapEvent } from '@opentui/keymap';
import { useKeymap } from '@opentui/keymap/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { CommandMap } from './keybind.js';
import type { OpenTuiKeymap } from './keymap-instance.js';
import { BASE_MODE, useModeStack } from './mode-stack.js';
import { useKeymapSelectorReact } from './use-keymap-selector.js';

// ---------------------------------------------------------------------------
// Command / chord constants (single source: keybind.ts CommandMap + Definitions)
// ---------------------------------------------------------------------------

export const WHICH_KEY_TOGGLE_COMMAND: string = CommandMap.which_key_toggle;
export const WHICH_KEY_LAYOUT_COMMAND: string = CommandMap.which_key_layout_toggle;
/** `ctrl+alt+k` from `Definitions.which_key_toggle`. */
const WHICH_KEY_TOGGLE_KEY = 'ctrl+alt+k';
/** `ctrl+alt+shift+k` from `Definitions.which_key_layout_toggle`. */
const WHICH_KEY_LAYOUT_KEY = 'ctrl+alt+shift+k';

/** Commands the panel registers itself — excluded from its own display list. */
const WHICH_KEY_PANEL_COMMANDS: ReadonlySet<string> = new Set<string>([
    WHICH_KEY_TOGGLE_COMMAND,
    WHICH_KEY_LAYOUT_COMMAND,
]);

/** Panel placement. `overlay` floats (absolute); `dock` sits in-flow. */
export type WhichKeyLayout = 'dock' | 'overlay';

// ---------------------------------------------------------------------------
// Pure projection types (structural; accept real + test keymap entries)
// ---------------------------------------------------------------------------

interface SequencePartProjection {
    readonly display: string;
}

interface BindingProjection {
    readonly sequence: readonly SequencePartProjection[];
}

interface CommandProjection {
    readonly name: string;
    readonly [key: string]: unknown;
}

/**
 * Structural slice of `CommandEntry` carrying only what the projection reads
 * (command name/metadata + each binding's parsed sequence). The real
 * `CommandEntry<Renderable,KeyEvent>` and the testing
 * `CommandEntry<TestKeymapTarget,TestKeymapEvent>` both satisfy this, so
 * `projectWhichKeyEntries` is unit-testable against a real keymap without a
 * variance mismatch (T4 InputBinding learning).
 */
export interface CommandEntryProjection {
    readonly command: CommandProjection;
    readonly bindings: readonly BindingProjection[];
}

// ---------------------------------------------------------------------------
// Pure helpers (FFI-free, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Declared-property view over a `Command`'s display metadata. `Command`
 * exposes these via its index signature, so dot-access trips
 * `noPropertyAccessFromIndexSignature`; narrowing to this declared shape lets
 * dot-access pass both TS and Biome `useLiteralKeys` (same pattern as T8's
 * `CommandDisplayMeta`). `name` is the common declared property making the
 * assertion legal.
 */
interface CommandDisplayMeta {
    readonly name: string;
    readonly hidden?: unknown;
    readonly title?: unknown;
    readonly desc?: unknown;
    readonly category?: unknown;
    readonly group?: unknown;
    readonly mode?: unknown;
}

/** Join a parsed key sequence's part display strings into one chord label. */
export function formatSequence(sequence: readonly SequencePartProjection[]): string {
    let out = '';
    for (const part of sequence) {
        if (part.display.length === 0) continue;
        out = out.length === 0 ? part.display : `${out} ${part.display}`;
    }
    return out;
}

/** The mode a command belongs to (defaults to base when untagged). */
function commandMode(meta: CommandDisplayMeta): string {
    return typeof meta.mode === 'string' ? meta.mode : BASE_MODE;
}

/** Derive a display group label: command category > group > name namespace. */
function commandGroup(meta: CommandDisplayMeta): string {
    const category = meta.category;
    if (typeof category === 'string' && category.length > 0) return category;
    const group = meta.group;
    if (typeof group === 'string' && group.length > 0) return group;
    const dot = meta.name.indexOf('.');
    return dot > 0 ? meta.name.slice(0, dot) : 'general';
}

/** Derive a human label: command title > desc > name. */
function commandLabel(meta: CommandDisplayMeta): string {
    const title = meta.title;
    if (typeof title === 'string' && title.length > 0) return title;
    const desc = meta.desc;
    if (typeof desc === 'string' && desc.length > 0) return desc;
    return meta.name;
}

/** A single displayed binding row: the chord and its description. */
export interface WhichKeyEntry {
    readonly key: string;
    readonly label: string;
    readonly group: string;
}

/** A named group of binding rows. */
export interface WhichKeyGroup {
    readonly label: string;
    readonly entries: readonly WhichKeyEntry[];
}

/**
 * Filter + group reachable command entries for `currentModeValue`. Excludes
 * hidden commands, the panel's own toggle/layout commands, commands whose
 * declared mode does not match, and bindings with no resolved chord. Each
 * binding alternative becomes one entry (a multi-chord command appears once
 * per chord). Pure; deterministic (sorted by group, then label, then chord).
 */
export function projectWhichKeyEntries(
    entries: readonly CommandEntryProjection[],
    currentModeValue: string,
): readonly WhichKeyGroup[] {
    const collected: WhichKeyEntry[] = [];
    for (const entry of entries) {
        const meta = entry.command as CommandDisplayMeta;
        if (meta.hidden === true) continue;
        if (WHICH_KEY_PANEL_COMMANDS.has(meta.name)) continue;
        if (commandMode(meta) !== currentModeValue) continue;
        for (const binding of entry.bindings) {
            const chord = formatSequence(binding.sequence);
            if (chord.length === 0) continue;
            collected.push({ key: chord, label: commandLabel(meta), group: commandGroup(meta) });
        }
    }
    return groupEntries(collected);
}

/** Group flat entries by their `group` field, sorted for stable display. */
export function groupEntries(entries: readonly WhichKeyEntry[]): readonly WhichKeyGroup[] {
    const buckets = new Map<string, WhichKeyEntry[]>();
    for (const entry of entries) {
        const bucket = buckets.get(entry.group);
        if (bucket === undefined) {
            buckets.set(entry.group, [entry]);
        } else {
            bucket.push(entry);
        }
    }
    const groups: WhichKeyGroup[] = [];
    for (const [label, bucket] of buckets) {
        bucket.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
        groups.push({ label, entries: bucket });
    }
    groups.sort((a, b) => a.label.localeCompare(b.label));
    return groups;
}

/** Cycle the panel layout: dock <-> overlay. */
export function nextLayout(layout: WhichKeyLayout): WhichKeyLayout {
    return layout === 'dock' ? 'overlay' : 'dock';
}

// ---------------------------------------------------------------------------
// STABLE module-level selector (T1 snapshot-stability rule)
// ---------------------------------------------------------------------------

/**
 * STABLE module-level selector returning all reachable command entries (with
 * their parsed binding sequences). Mode filtering + grouping happen in the
 * pure `projectWhichKeyEntries` step, driven by the React mode-stack context,
 * so this selector never closes over mode (which would bust the T1 store's
 * selector-identity cache and never re-derive).
 */
function selectReachableEntries(km: OpenTuiKeymap): readonly CommandEntryProjection[] {
    return km.getCommandEntries({ visibility: 'reachable' });
}

// ---------------------------------------------------------------------------
// Layer registration (FFI-free, testable via handler callbacks)
// ---------------------------------------------------------------------------

/** React-state setters the panel's toggle/layout commands invoke. */
export interface WhichKeyHandlers {
    readonly onToggle: () => void;
    readonly onLayoutToggle: () => void;
}

/**
 * Register the which-key toggle + layout-toggle layer. Always enabled; binds
 * the chords from keybind.ts to `which-key.toggle` / `which-key.layout.toggle`
 * commands whose handlers call back into React state. Returns a disposer.
 * Generic over the keymap's target/event so it accepts both the production
 * opentui keymap and the `createTestKeymap` fake (T7/T10 pattern).
 */
export function registerWhichKeyLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    handlers: WhichKeyHandlers,
): () => void {
    return keymap.registerLayer({
        enabled: () => true,
        commands: [
            {
                name: WHICH_KEY_TOGGLE_COMMAND,
                run: () => {
                    handlers.onToggle();
                    return true;
                },
            },
            {
                name: WHICH_KEY_LAYOUT_COMMAND,
                run: () => {
                    handlers.onLayoutToggle();
                    return true;
                },
            },
        ],
        bindings: [
            { key: WHICH_KEY_TOGGLE_KEY, cmd: WHICH_KEY_TOGGLE_COMMAND },
            { key: WHICH_KEY_LAYOUT_KEY, cmd: WHICH_KEY_LAYOUT_COMMAND },
        ],
    });
}

// ---------------------------------------------------------------------------
// Component (rendered only in the live TUI; not unit-tested)
// ---------------------------------------------------------------------------

export function WhichKeyPanel(): ReactNode {
    const keymap = useKeymap();
    const { current: currentModeValue } = useModeStack();
    const entries = useKeymapSelectorReact(selectReachableEntries);
    const [open, setOpen] = useState(false);
    const [layout, setLayout] = useState<WhichKeyLayout>('dock');

    // Stable callbacks reading only React setters; the layer is registered
    // once per keymap and tears down on unmount/keymap change.
    const handlers = useMemo<WhichKeyHandlers>(
        () => ({
            onToggle: () => setOpen((value) => !value),
            onLayoutToggle: () => setLayout((value) => nextLayout(value)),
        }),
        [],
    );
    useEffect(() => registerWhichKeyLayer(keymap, handlers), [keymap, handlers]);

    const groups = useMemo(() => projectWhichKeyEntries(entries, currentModeValue), [entries, currentModeValue]);

    if (!open) return null;
    return <WhichKeyWindow groups={groups} layout={layout} currentMode={currentModeValue} />;
}

function WhichKeyWindow(props: {
    readonly groups: readonly WhichKeyGroup[];
    readonly layout: WhichKeyLayout;
    readonly currentMode: string;
}): ReactNode {
    const { groups, layout, currentMode } = props;
    const dimAttrs = { dim: true };
    const accentFg = '#00ffff';
    const keyFg = '#ffff00';
    const borderColor = '#808080';
    const absolute = layout === 'overlay';
    const next = nextLayout(layout);

    const rows: ReactNode[] = [];
    if (groups.length === 0) {
        rows.push(<text key="empty" {...dimAttrs}>{`  No ${currentMode} bindings`}</text>);
    }
    for (let gi = 0; gi < groups.length; gi += 1) {
        const group = groups[gi];
        if (group === undefined) continue;
        rows.push(
            <text key={`g${gi}`} {...dimAttrs} {...(accentFg !== undefined ? { fg: accentFg } : {})}>
                {group.label}
            </text>,
        );
        for (let ei = 0; ei < group.entries.length; ei += 1) {
            const entry = group.entries[ei];
            if (entry === undefined) continue;
            rows.push(
                <text key={`g${gi}e${ei}`} {...dimAttrs}>
                    {'  '}
                    <span {...(keyFg !== undefined ? { fg: keyFg } : {})}>{entry.key.padEnd(14)}</span>
                    {` ${entry.label}`}
                </text>,
            );
        }
    }

    return (
        <box
            flexDirection="column"
            {...(absolute ? { position: 'absolute', top: 1, left: 2, right: 2 } : { left: 0, right: 0 })}
            {...(borderColor !== undefined ? { borderStyle: 'single', borderColor } : { borderStyle: 'single' })}
        >
            <text {...dimAttrs} {...(accentFg !== undefined ? { fg: accentFg } : {})}>
                {`Key bindings (${currentMode})  Ctrl+Alt+K close  Ctrl+Alt+Shift+K ${next}`}
            </text>
            {rows}
        </box>
    );
}
