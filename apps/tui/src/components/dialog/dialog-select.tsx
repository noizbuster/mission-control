/** @jsxImportSource @opentui/solid */

import { type MouseEvent, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, For, Show, type JSX, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useDialog, type DialogContext } from './dialog';
import { SELECTED_BG } from '../overlay-theme';

export type DialogSelectOption<T = unknown> = {
    readonly title: string;
    readonly value: T;
    readonly description?: string;
    readonly disabled?: boolean;
};

export type DialogSelectAction<T = unknown> = {
    readonly key: string;
    readonly title: string;
    readonly side?: 'left' | 'right';
    readonly hidden?: boolean;
    readonly disabled?: boolean;
    readonly onTrigger: (option: DialogSelectOption<T> | undefined) => void;
};

export type DialogSelectProps<T = unknown> = {
    readonly title: string;
    readonly options: readonly DialogSelectOption<T>[];
    readonly placeholder?: string;
    readonly multiple?: boolean;
    readonly current?: T;
    readonly onSelect?: (option: DialogSelectOption<T>) => void;
    readonly onCancel?: () => void;
    readonly actions?: readonly DialogSelectAction<T>[];
    readonly maxVisible?: number;
};

const DEFAULT_MAX_VISIBLE = 12;

function matchFilter(option: DialogSelectOption, query: string): boolean {
    if (query.length === 0) return true;
    const lower = query.toLowerCase();
    if (option.title.toLowerCase().includes(lower)) return true;
    if (option.description !== undefined && option.description.toLowerCase().includes(lower)) return true;
    return false;
}

export function DialogSelect<T>(props: DialogSelectProps<T>): JSX.Element {
    const dialog = useDialog();
    const maxVisible = (): number => props.maxVisible ?? DEFAULT_MAX_VISIBLE;

    const [store, setStore] = createStore({
        selected: 0,
        filter: '',
        selectedIndices: new Set<number>(),
    });
    const [inputMode, setInputMode] = createSignal<'keyboard' | 'mouse'>('keyboard');

    const filtered = createMemo(() => {
        const query = store.filter;
        if (query.length === 0) return props.options;
        return props.options.filter((opt) => matchFilter(opt, query));
    });

    const visibleStart = createMemo(() => {
        const max = maxVisible();
        const sel = store.selected;
        if (sel < max) return 0;
        return sel - max + 1;
    });

    const visibleOptions = createMemo(() => {
        const start = visibleStart();
        const end = Math.min(start + maxVisible(), filtered().length);
        return filtered().slice(start, end);
    });

    const currentOption = createMemo((): DialogSelectOption<T> | undefined => {
        return filtered()[store.selected];
    });

    onMount(() => {
        dialog.setSize('medium');
        if (props.current !== undefined) {
            const idx = props.options.findIndex((opt) => opt.value === props.current);
            if (idx >= 0) setStore('selected', idx);
        }
    });

    function moveTo(index: number): void {
        const len = filtered().length;
        if (len === 0) return;
        const clamped = ((index % len) + len) % len;
        setStore('selected', clamped);
    }

    function pageUp(): void {
        moveTo(store.selected - maxVisible());
    }

    function pageDown(): void {
        moveTo(store.selected + maxVisible());
    }

    function submit(): void {
        const opt = currentOption();
        if (opt === undefined) return;
        if (opt.disabled) return;
        if (props.multiple === true) {
            const next = new Set(store.selectedIndices);
            const realIndex = props.options.indexOf(opt);
            if (next.has(realIndex)) {
                next.delete(realIndex);
            } else {
                next.add(realIndex);
            }
            setStore('selectedIndices', next);
            return;
        }
        props.onSelect?.(opt);
    }

    function confirm(): void {
        const opt = currentOption();
        if (opt === undefined) return;
        if (opt.disabled) return;
        if (props.multiple === true) {
            const selected = Array.from(store.selectedIndices).map((i) => props.options[i]).filter((o): o is DialogSelectOption<T> => o !== undefined);
            props.onSelect?.(selected[0] ?? opt);
            return;
        }
        props.onSelect?.(opt);
    }

    function triggerAction(action: DialogSelectAction<T>): void {
        if (action.disabled) return;
        action.onTrigger(currentOption());
    }

    useKeyboard((key) => {
        setInputMode('keyboard');

        if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
            key.preventDefault();
            moveTo(store.selected - 1);
            return;
        }
        if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
            key.preventDefault();
            moveTo(store.selected + 1);
            return;
        }
        if (key.name === 'pageup') {
            key.preventDefault();
            pageUp();
            return;
        }
        if (key.name === 'pagedown') {
            key.preventDefault();
            pageDown();
            return;
        }
        if (key.name === 'home') {
            key.preventDefault();
            moveTo(0);
            return;
        }
        if (key.name === 'end') {
            key.preventDefault();
            moveTo(filtered().length - 1);
            return;
        }
        if (key.name === 'return') {
            key.preventDefault();
            confirm();
            return;
        }
        if (key.name === 'space' && props.multiple === true) {
            key.preventDefault();
            submit();
            return;
        }
        if (key.name === 'backspace') {
            setStore('filter', store.filter.slice(0, -1));
            setStore('selected', 0);
            return;
        }
        if (props.actions !== undefined) {
            for (const action of props.actions) {
                if (action.hidden) continue;
                if (key.name === action.key || key.sequence === action.key) {
                    key.preventDefault();
                    triggerAction(action);
                    return;
                }
            }
        }
        if (key.ctrl || key.meta || key.super) return;
        if (key.name === 'escape') return;
        if (key.sequence.length === 1 && key.sequence >= ' ' && key.sequence <= '~') {
            setStore('filter', store.filter + key.sequence);
            setStore('selected', 0);
        }
    });

    const onOptionClick = (globalIndex: number) => (event: MouseEvent) => {
        if (event.button !== 0) return;
        if (globalIndex < 0 || globalIndex >= filtered().length) return;
        const opt = filtered()[globalIndex];
        if (opt === undefined || opt.disabled) return;
        setStore('selected', globalIndex);
        if (props.multiple === true) {
            submit();
        } else {
            props.onSelect?.(opt);
        }
    };

    const onOptionHover = (globalIndex: number) => (): void => {
        if (inputMode() !== 'mouse') return;
        if (globalIndex < 0 || globalIndex >= filtered().length) return;
        setStore('selected', globalIndex);
    };

    const visibleActions = createMemo(() => {
        if (props.actions === undefined) return [];
        return props.actions.filter((a) => !a.hidden);
    });

    return (
        <box paddingLeft={2} paddingRight={2} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
                <text attributes={TextAttributes.BOLD} fg="#ffffff">
                    {props.title}
                </text>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <text> has no role concept; click-to-close is a dialog UX pattern */}
                <text fg="#888888" onMouseUp={() => dialog.clear()}>
                    esc
                </text>
            </box>
            <Show when={store.filter.length > 0}>
                <text fg="#888888">{`Search: ${store.filter}`}</text>
            </Show>
            <Show when={filtered().length === 0}>
                <text fg="#888888">{props.placeholder ?? 'No matches'}</text>
            </Show>
            <For each={visibleOptions()}>
                {(option, index) => {
                    const globalIndex = () => visibleStart() + index();
                    const isSelected = () => globalIndex() === store.selected;
                    const isChecked = () => {
                        const realIdx = props.options.indexOf(option);
                        return store.selectedIndices.has(realIdx);
                    };
                    return (
                        // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; keyboard nav already exists, mouse is enhancement
                        <box
                            flexDirection="column"
                            onMouseDown={onOptionClick(globalIndex())}
                            onMouseOver={onOptionHover(globalIndex())}
                            {...(isSelected() ? { backgroundColor: SELECTED_BG } : {})}
                        >
                            <box flexDirection="row">
                                <text fg={isSelected() ? '#ffff00' : '#888888'}>
                                    {isSelected() ? '\u276f ' : '  '}
                                </text>
                                {props.multiple === true ? (
                                    <text {...(isSelected() ? { fg: '#ffffff' } : {})}>
                                        {isChecked() ? '[x] ' : '[ ] '}
                                        {option.title}
                                    </text>
                                ) : (
                                    <text {...(isSelected() ? { fg: '#ffffff', attributes: TextAttributes.BOLD } : {})}>
                                        {option.title}
                                    </text>
                                )}
                            </box>
                            {option.description !== undefined ? (
                                <box flexDirection="row" paddingLeft={2}>
                                    <text attributes={TextAttributes.DIM}>{option.description}</text>
                                </box>
                            ) : null}
                        </box>
                    );
                }}
            </For>
            <Show when={visibleActions().length > 0}>
                <box flexDirection="row" gap={2} paddingBottom={1}>
                    <For each={visibleActions()}>
                        {(action) => (
                            <text fg="#888888">
                                {`${action.key} ${action.title}`}
                            </text>
                        )}
                    </For>
                </box>
            </Show>
            <box paddingBottom={1} flexDirection="row">
                <text fg="#888888">
                    {props.multiple === true
                        ? '\u2191/\u2193 navigate \u00b7 Space toggle \u00b7 Enter confirm \u00b7 type to search'
                        : '\u2191/\u2193 navigate \u00b7 Enter select \u00b7 type to search'}
                </text>
            </box>
        </box>
    );
}

DialogSelect.show = <T,>(
    dialog: DialogContext,
    props: Omit<DialogSelectProps<T>, 'onSelect' | 'onCancel'>,
): Promise<DialogSelectOption<T> | undefined> => {
    return new Promise<DialogSelectOption<T> | undefined>((resolve) => {
        dialog.replace(
            <DialogSelect
                {...props}
                onSelect={(opt: DialogSelectOption<T>) => resolve(opt)}
                onCancel={() => resolve(undefined)}
            />,
            () => resolve(undefined),
        );
    });
};
