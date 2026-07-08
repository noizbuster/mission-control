import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

export interface SolidSelectableStore<TSnapshot> {
    readonly subscribe: (onStoreChange: () => void) => () => void;
    readonly getSnapshot: () => TSnapshot;
}

export function useSolidStoreSelector<TSnapshot, TSelection>(
    store: SolidSelectableStore<TSnapshot>,
    selector: (snapshot: TSnapshot) => TSelection,
): Accessor<TSelection> {
    const selectSnapshot = (): TSelection => selector(store.getSnapshot());
    const [selection, setSelection] = createSignal(selectSnapshot(), { equals: Object.is });
    const updateSelection = (): void => {
        setSelection(() => selectSnapshot());
    };

    onMount(() => {
        const unsubscribe = store.subscribe(updateSelection);
        updateSelection();
        onCleanup(unsubscribe);
    });

    return selection;
}
