export type PrintableKey = {
    readonly name: string;
    readonly ctrl: boolean;
    readonly meta: boolean;
};

export function printableCharFromKey(key: PrintableKey): string | undefined {
    if (key.ctrl || key.meta) return undefined;
    if (key.name === 'space') return ' ';
    if (key.name.length === 1) return key.name;
    return undefined;
}
