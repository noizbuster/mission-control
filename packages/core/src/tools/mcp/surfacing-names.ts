export function sanitizeMcpName(name: string): string {
    let result = '';
    let lastWasSeparator = true;
    for (const char of name) {
        if (/[a-zA-Z0-9_]/.test(char)) {
            result += char;
            lastWasSeparator = false;
        } else if (!lastWasSeparator) {
            result += '_';
            lastWasSeparator = true;
        }
    }
    return result.replace(/_+$/, '');
}

export function mcpToolName(serverName: string, toolName: string): string {
    return `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`;
}

export function uniqueMcpRegistrationName(base: string, registered: ReadonlySet<string>): string {
    if (!registered.has(base)) return base;
    let suffix = 2;
    while (registered.has(`${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
}
