import { redactCredentialLines, redactCredentialText } from '@mission-control/core/redaction';

export function redactDisplayText(text: string): string {
    return redactCredentialText(text, []);
}

export function redactDisplayLines(lines: readonly string[]): readonly string[] {
    return redactCredentialLines(lines).map((line) => line.text);
}

export function redactMessageFields<Item extends { readonly message: string }>(
    items: readonly Item[],
): readonly Item[] {
    return items.map((item) => ({ ...item, message: redactDisplayText(item.message) }));
}
