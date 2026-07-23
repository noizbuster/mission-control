export type PrintableKey = {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly super?: boolean;
};

export function printableCharFromKey(key: PrintableKey): string | undefined {
    if (key.ctrl || key.meta || key.super) return undefined;
    if (key.sequence?.length === 1) return key.sequence;
    if (key.name === 'space') return ' ';
    if (key.name.length === 1) return key.name;
    return undefined;
}
