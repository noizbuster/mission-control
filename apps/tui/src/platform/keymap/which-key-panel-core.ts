import type { Keymap, KeymapEvent } from '@opentui/keymap';
import { CommandMap } from './keybind.js';
import type { OpenTuiKeymap } from './keymap-instance.js';
import { BASE_MODE } from './mode-stack.js';

export const WHICH_KEY_TOGGLE_COMMAND: string = CommandMap.which_key_toggle;
export const WHICH_KEY_LAYOUT_COMMAND: string = CommandMap.which_key_layout_toggle;
const WHICH_KEY_TOGGLE_KEY = 'ctrl+alt+k';
const WHICH_KEY_LAYOUT_KEY = 'ctrl+alt+shift+k';

const WHICH_KEY_PANEL_COMMANDS: ReadonlySet<string> = new Set<string>([
    WHICH_KEY_TOGGLE_COMMAND,
    WHICH_KEY_LAYOUT_COMMAND,
]);

export type WhichKeyLayout = 'dock' | 'overlay';

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

export interface CommandEntryProjection {
    readonly command: CommandProjection;
    readonly bindings: readonly BindingProjection[];
}

interface CommandDisplayMeta {
    readonly name: string;
    readonly hidden?: unknown;
    readonly title?: unknown;
    readonly desc?: unknown;
    readonly category?: unknown;
    readonly group?: unknown;
    readonly mode?: unknown;
}

export function formatSequence(sequence: readonly SequencePartProjection[]): string {
    let out = '';
    for (const part of sequence) {
        if (part.display.length === 0) continue;
        out = out.length === 0 ? part.display : `${out} ${part.display}`;
    }
    return out;
}

function commandMode(meta: CommandDisplayMeta): string {
    return typeof meta.mode === 'string' ? meta.mode : BASE_MODE;
}

function commandGroup(meta: CommandDisplayMeta): string {
    const category = meta.category;
    if (typeof category === 'string' && category.length > 0) return category;
    const group = meta.group;
    if (typeof group === 'string' && group.length > 0) return group;
    const dot = meta.name.indexOf('.');
    return dot > 0 ? meta.name.slice(0, dot) : 'general';
}

function commandLabel(meta: CommandDisplayMeta): string {
    const title = meta.title;
    if (typeof title === 'string' && title.length > 0) return title;
    const desc = meta.desc;
    if (typeof desc === 'string' && desc.length > 0) return desc;
    return meta.name;
}

export interface WhichKeyEntry {
    readonly key: string;
    readonly label: string;
    readonly group: string;
}

export interface WhichKeyGroup {
    readonly label: string;
    readonly entries: readonly WhichKeyEntry[];
}

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

export function nextLayout(layout: WhichKeyLayout): WhichKeyLayout {
    return layout === 'dock' ? 'overlay' : 'dock';
}

export function selectReachableEntries(km: OpenTuiKeymap): readonly CommandEntryProjection[] {
    return km.getCommandEntries({ visibility: 'reachable' });
}

export interface WhichKeyHandlers {
    readonly onToggle: () => void;
    readonly onLayoutToggle: () => void;
}

type WhichKeyLayer<TTarget extends object, TEvent extends KeymapEvent> = Omit<
    Parameters<Keymap<TTarget, TEvent>['registerLayer']>[0],
    'target' | 'targetMode'
>;

export function createWhichKeyLayer<TTarget extends object, TEvent extends KeymapEvent>(
    handlers: WhichKeyHandlers,
): WhichKeyLayer<TTarget, TEvent> {
    return {
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
    };
}

export function registerWhichKeyLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    handlers: WhichKeyHandlers,
): () => void {
    return keymap.registerLayer(createWhichKeyLayer(handlers));
}
