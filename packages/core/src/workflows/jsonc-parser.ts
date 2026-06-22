/**
 * Minimal JSONC comment stripper. Removes `//` line comments and `/* ... *\/`
 * block comments while preserving comment-like text inside JSON string values.
 * No external dependency; the result is meant to be passed to `JSON.parse`.
 *
 * Limitation (v1): trailing commas are NOT stripped. Workflow files must stay
 * comma-valid JSON after comment removal.
 */
export function stripJsoncComments(input: string): string {
    const out: string[] = [];
    let i = 0;
    let inString = false;
    while (i < input.length) {
        const char = input[i];
        if (char === undefined) {
            i += 1;
            continue;
        }
        if (inString) {
            out.push(char);
            if (char === '\\' && i + 1 < input.length) {
                const escaped = input[i + 1];
                if (escaped !== undefined) {
                    out.push(escaped);
                }
                i += 2;
                continue;
            }
            if (char === '"') {
                inString = false;
            }
            i += 1;
            continue;
        }
        const next = i + 1 < input.length ? input[i + 1] : undefined;
        if (char === '"') {
            inString = true;
            out.push(char);
            i += 1;
            continue;
        }
        if (char === '/' && next === '/') {
            i += 2;
            while (i < input.length && input[i] !== '\n') {
                i += 1;
            }
            continue;
        }
        if (char === '/' && next === '*') {
            i += 2;
            while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(char);
        i += 1;
    }
    return out.join('');
}
