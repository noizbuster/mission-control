const redactedCredential = '[REDACTED_CREDENTIAL]';
const tokenLikeSecretPattern = /sk-[A-Za-z0-9_-]+/g;

export function redactDisplayText(text: string): string {
    return text.replace(tokenLikeSecretPattern, redactedCredential);
}

export function redactMessageFields<Item extends { readonly message: string }>(
    items: readonly Item[],
): readonly Item[] {
    return items.map((item) => ({ ...item, message: redactDisplayText(item.message) }));
}
