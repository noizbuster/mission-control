export type CommandParts = {
    readonly head: string;
    readonly tail: string;
};

export function splitCommandParts(input: string): CommandParts {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { head: '', tail: '' };
    }
    const firstWhitespace = trimmed.search(/\s/);
    if (firstWhitespace < 0) {
        return { head: trimmed, tail: '' };
    }
    return {
        head: trimmed.slice(0, firstWhitespace),
        tail: trimmed.slice(firstWhitespace + 1).trim(),
    };
}
