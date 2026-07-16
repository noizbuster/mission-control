/**
 * Pure scroll window for ABG list panes. `offset` skips that many leading rows
 * (↑ increases offset in the keyboard driver). Clamped so empty lists and
 * overscroll stay well-defined.
 */
export function scrolledSlice<T>(items: readonly T[], offset: number): readonly T[] {
    if (items.length === 0) return items;
    const start = Math.max(0, Math.min(Math.trunc(offset), items.length - 1));
    return items.slice(start);
}
