function escapeRegExp(value: string): string {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .split('**')
        .map((segment) => segment.split('*').map(escapeRegExp).join('[^]*'))
        .join('[^]*');
    return new RegExp(`^${source}$`);
}

export function matchesGlob(value: string, pattern: string): boolean {
    return globToRegExp(pattern).test(value);
}
