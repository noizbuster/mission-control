export function parseCommandRunPreview(
    argumentsJson: string,
): { readonly command: string; readonly args: readonly string[] } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.command !== 'string' || value.command.length === 0) return undefined;
    const args = value.args;
    if (args === undefined) return { command: value.command, args: [] };
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) return undefined;
    return { command: value.command, args: [...args] };
}

export function parsePatchPreview(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.patch === 'string' && value.patch.length > 0 ? value.patch : undefined;
}

export function parseBashRunPreview(argumentsJson: string): { readonly commandLine: string } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.commandLine !== 'string' || value.commandLine.length === 0) return undefined;
    return { commandLine: value.commandLine };
}

export function parseFileEditPreview(argumentsJson: string): { readonly path: string } | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.oldText !== 'string' ||
        value.oldText.length === 0 ||
        typeof value.newText !== 'string'
    ) {
        return undefined;
    }
    if (value.occurrence !== undefined && !isPositiveInteger(value.occurrence)) return undefined;
    if (value.replaceAll !== undefined && typeof value.replaceAll !== 'boolean') return undefined;
    if (value.occurrence !== undefined && value.replaceAll !== undefined) return undefined;
    if (value.oldText === value.newText) return undefined;
    return { path: value.path };
}

export function parseHashlineEditPreview(argumentsJson: string): { readonly path: string } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.path !== 'string' || value.path.length === 0) return undefined;
    if (value.delete === true) {
        if (value.edits !== undefined && !(Array.isArray(value.edits) && value.edits.length === 0)) return undefined;
        return { path: value.path };
    }
    if (!Array.isArray(value.edits) || value.edits.length === 0) return undefined;
    return { path: value.path };
}

export function parseWebfetchUrl(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.url === 'string' && value.url.length > 0 ? value.url : undefined;
}

export function parseWebSearchQuery(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.query === 'string' && value.query.length > 0 ? value.query : undefined;
}

export function parseTaskDescription(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.description === 'string' && value.description.length > 0
        ? value.description
        : undefined;
}

export function parseFileWritePreview(
    argumentsJson: string,
): { readonly path: string; readonly createParents: boolean } | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.content !== 'string'
    ) {
        return undefined;
    }
    if (value.createParents !== undefined && typeof value.createParents !== 'boolean') return undefined;
    if (isBinaryWriteContent(value.content)) return undefined;
    return { path: value.path, createParents: value.createParents === true };
}

export function patchTargetPaths(patch: string): readonly string[] {
    const paths = new Set<string>();
    for (const line of patch.split('\n')) {
        const diffMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        if (diffMatch?.[1] !== undefined) {
            paths.add(diffMatch[1]);
            continue;
        }
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1] !== undefined) paths.add(fileMatch[1]);
    }
    return [...paths];
}

function isBinaryWriteContent(content: string): boolean {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length === 0) return false;
    let suspicious = 0;
    for (const byte of bytes) {
        if (byte === 0) return true;
        if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
    }
    return suspicious / bytes.length > 0.3;
}

function parseArguments(argumentsJson: string): unknown {
    try {
        return JSON.parse(argumentsJson);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is {
    readonly args?: unknown;
    readonly command?: unknown;
    readonly commandLine?: unknown;
    readonly content?: unknown;
    readonly createParents?: unknown;
    readonly delete?: unknown;
    readonly description?: unknown;
    readonly edits?: unknown;
    readonly newText?: unknown;
    readonly occurrence?: unknown;
    readonly oldText?: unknown;
    readonly patch?: unknown;
    readonly path?: unknown;
    readonly query?: unknown;
    readonly replaceAll?: unknown;
    readonly url?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
