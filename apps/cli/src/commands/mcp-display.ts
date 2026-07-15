const QUERY_VALUE_MASK = '***';
const INVALID_URL_MASK = '[REDACTED URL]';

export function formatRemoteUrlForDisplay(rawUrl: string): string {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return INVALID_URL_MASK;
    }
    const rawWithoutQueryOrFragment = rawUrl.split(/[?#]/u, 1)[0] ?? rawUrl;
    const omittedRootSlash = parsed.pathname === '/' && !rawWithoutQueryOrFragment.endsWith('/');
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    if (parsed.search.length > 0) {
        parsed.search = maskQueryValues(parsed.search);
    }
    const displayUrl = parsed.toString();
    return omittedRootSlash
        ? displayUrl.replace(`${parsed.protocol}//${parsed.host}/`, `${parsed.protocol}//${parsed.host}`)
        : displayUrl;
}

function maskQueryValues(search: string): string {
    return `?${search
        .slice(1)
        .split('&')
        .map((part) => {
            const equalsIndex = part.indexOf('=');
            const key = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
            return `${key}=${QUERY_VALUE_MASK}`;
        })
        .join('&')}`;
}
