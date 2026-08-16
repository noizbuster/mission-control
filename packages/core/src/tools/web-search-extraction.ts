/**
 * Site-aware extraction for web search results (task 29).
 *
 * Routes a result URL to a site-specific handler that fetches structured data
 * (registry JSON APIs for npm/PyPI/crates.io, GitHub raw/API for code hosts)
 * and renders it to structured markdown. Unknown hosts fall through to a
 * generic fetch + `htmlToMarkdown` (N-API module from task 8) conversion so the
 * model still gets readable markdown with anchors intact.
 *
 * Ported compactly from oh-my-pi's `web/scrapers` architecture: an ordered
 * array of `null`-returning handlers plus a linear-scan dispatcher. Each
 * handler self-gates on hostname/path and returns `null` ("not mine") on
 * mismatch. The NativesClient is injectable so tests exercise extraction
 * without the native addon.
 */
import type { NativesClient } from '../native/natives-client';

const EXTRACTION_TIMEOUT_MS = 15_000;
const MAX_EXTRACT_CHARS = 20_000;

export type ExtractionResult = {
    readonly url: string;
    readonly markdown: string;
    readonly method: string;
};

type SiteHandler = (
    url: URL,
    signal: AbortSignal,
    natives: NativesClient | undefined,
) => Promise<ExtractionResult | null>;

/** Ordered handlers; first non-null wins. */
const HANDLERS: readonly SiteHandler[] = [handleNpm, handlePypi, handleCratesIo, handleGitHub, handleGitLab];

/**
 * Extract structured markdown from a result URL. Returns `undefined` when no
 * handler matched and the generic fetch failed or the body was empty. Never
 * throws: extraction failures degrade to `undefined` so the search result
 * still surfaces its snippet.
 */
export async function extractSiteContent(
    url: string,
    natives: NativesClient | undefined,
    signal: AbortSignal,
): Promise<ExtractionResult | undefined> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
    const linked = linkSignals(signal, controller);
    try {
        for (const handler of HANDLERS) {
            try {
                const result = await handler(parsed, linked, natives);
                if (result !== null) {
                    return { ...result, markdown: truncate(result.markdown, MAX_EXTRACT_CHARS) };
                }
            } catch {}
        }
        return await genericHtmlExtract(parsed, linked, natives);
    } finally {
        clearTimeout(timer);
    }
}

/** Generic fallback: fetch the page, convert HTML to markdown via N-API. */
async function genericHtmlExtract(
    url: URL,
    signal: AbortSignal,
    natives: NativesClient | undefined,
): Promise<ExtractionResult | undefined> {
    const response = await fetch(url.href, {
        signal,
        headers: { accept: 'text/html, application/xhtml+xml', 'user-agent': userAgent() },
    });
    if (!response.ok) {
        return undefined;
    }
    const html = await response.text();
    if (html.trim().length === 0) {
        return undefined;
    }
    const markdown = natives?.htmlToMarkdown(html, { cleanContent: true, skipImages: false }) ?? stripTags(html);
    if (markdown.trim().length === 0) {
        return undefined;
    }
    return { url: url.href, markdown: truncate(markdown, MAX_EXTRACT_CHARS), method: 'html' };
}

// ---------------------------------------------------------------------------
// Registry-based sites (npm, PyPI, crates.io)
// ---------------------------------------------------------------------------

async function handleNpm(url: URL, signal: AbortSignal): Promise<ExtractionResult | null> {
    if (url.hostname !== 'www.npmjs.com' && url.hostname !== 'npmjs.com') return null;
    const match = url.pathname.match(/^\/package\/(@[^/]+\/[^/]+|[^/]+)/);
    if (match === null) return null;
    const pkg = match[1];
    if (pkg === undefined) return null;
    const meta = await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}/latest`,
        signal,
    );
    if (meta === undefined) return null;
    const lines: string[] = [`# ${meta['name'] ?? pkg}`];
    const description = asString(meta['description']);
    if (description) lines.push('', description);
    const version = asString(meta['version']);
    const license = asString(meta['license']);
    const metaParts: string[] = [];
    if (version) metaParts.push(`**Version:** ${version}`);
    if (license) metaParts.push(`**License:** ${license}`);
    if (metaParts.length > 0) lines.push('', metaParts.join(' · '));
    const homepage = asString(meta['homepage']);
    if (homepage) lines.push('', `**Homepage:** ${homepage}`);
    const repository = asRecord(meta['repository']);
    const repoUrl = repository ? asString(repository['url']) : asString(meta['repository']);
    if (repoUrl) lines.push(`**Repository:** ${repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')}`);
    const keywords = asArray(meta['keywords']);
    if (keywords && keywords.length > 0) {
        lines.push(
            `**Keywords:** ${keywords
                .map((k) => asString(k) ?? '')
                .filter((s) => s.length > 0)
                .join(', ')}`,
        );
    }
    const deps = asRecord(meta['dependencies']);
    if (deps && Object.keys(deps).length > 0) {
        lines.push('', '## Dependencies');
        for (const [dep, ver] of Object.entries(deps)) {
            lines.push(`- ${dep}: ${asString(ver) ?? ''}`);
        }
    }
    const readme = asString(meta['readme']);
    if (readme && readme.trim().length > 0) {
        lines.push('', '---', '', '## README', '', truncate(readme, 8000));
    }
    return { url: url.href, markdown: lines.join('\n'), method: 'npm' };
}

async function handlePypi(url: URL, signal: AbortSignal): Promise<ExtractionResult | null> {
    if (url.hostname !== 'pypi.org' && url.hostname !== 'pypi.python.org') return null;
    const match = url.pathname.match(/^\/project\/([^/]+)/);
    if (match === null) return null;
    const pkg = match[1];
    if (pkg === undefined) return null;
    const meta = await fetchJson(`https://pypi.org/pypi/${pkg}/json`, signal);
    if (meta === undefined) return null;
    const info = asRecord(meta['info']);
    if (info === undefined) return null;
    const lines: string[] = [`# ${asString(info['name']) ?? pkg}`];
    const summary = asString(info['summary']);
    if (summary) lines.push('', summary);
    const version = asString(info['version']);
    const license = asString(info['license']);
    const author = asString(info['author']);
    const metaParts: string[] = [];
    if (version) metaParts.push(`**Version:** ${version}`);
    if (license && license !== 'UNKNOWN') metaParts.push(`**License:** ${license}`);
    if (author) metaParts.push(`**Author:** ${author}`);
    if (metaParts.length > 0) lines.push('', metaParts.join(' · '));
    const home = asString(info['home_page']) ?? asString(info['project_url']);
    if (home) lines.push('', `**Homepage:** ${home}`);
    const classifiers = asArray(info['classifiers']);
    const topics = classifiers
        ?.map((c) => asString(c) ?? '')
        .filter((c) => c.startsWith('Topic ::'))
        .map((c) => c.replace('Topic :: ', ''));
    if (topics && topics.length > 0) {
        lines.push(`**Topics:** ${topics.join(', ')}`);
    }
    const requires = asArray(info['requires_dist']);
    if (requires && requires.length > 0) {
        lines.push('', '## Requires');
        for (const req of requires.slice(0, 30)) {
            lines.push(`- ${asString(req) ?? ''}`);
        }
    }
    const desc = asString(info['description']);
    if (desc && desc.trim().length > 0) {
        lines.push('', '---', '', '## Description', '', truncate(desc, 8000));
    }
    return { url: url.href, markdown: lines.join('\n'), method: 'pypi' };
}

async function handleCratesIo(url: URL, signal: AbortSignal): Promise<ExtractionResult | null> {
    if (url.hostname !== 'crates.io') return null;
    const match = url.pathname.match(/^\/crates\/([^/]+)/);
    if (match === null) return null;
    const pkg = match[1];
    if (pkg === undefined) return null;
    const meta = await fetchJson(`https://crates.io/api/v1/crates/${pkg}`, signal);
    if (meta === undefined) return null;
    const crate = asRecord(asRecord(meta['crate']));
    if (crate === undefined) return null;
    const lines: string[] = [`# ${asString(crate['name']) ?? pkg}`];
    const description = asString(crate['description']);
    if (description) lines.push('', description);
    const version = asString(crate['max_version']) ?? asString(crate['newest_version']);
    const license = asString(crate['license']);
    const downloads = asNumber(crate['downloads']);
    const metaParts: string[] = [];
    if (version) metaParts.push(`**Latest:** ${version}`);
    if (license) metaParts.push(`**License:** ${license}`);
    if (downloads !== undefined) metaParts.push(`**Downloads:** ${downloads.toLocaleString()}`);
    if (metaParts.length > 0) lines.push('', metaParts.join(' · '));
    const repo = asString(crate['repository']);
    if (repo) lines.push('', `**Repository:** ${repo}`);
    const homepage = asString(crate['homepage']);
    if (homepage) lines.push(`**Homepage:** ${homepage}`);
    const keywords = asArray(crate['keywords']);
    if (keywords && keywords.length > 0) {
        lines.push(
            `**Keywords:** ${keywords
                .map((k) => asString(k) ?? '')
                .filter((s) => s.length > 0)
                .join(', ')}`,
        );
    }
    const readme = asString(crate['readme']);
    if (readme && readme.trim().length > 0) {
        lines.push('', '---', '', '## README', '', truncate(readme, 8000));
    }
    return { url: url.href, markdown: lines.join('\n'), method: 'crates.io' };
}

// ---------------------------------------------------------------------------
// Code hosts (GitHub, GitLab)
// ---------------------------------------------------------------------------

async function handleGitHub(url: URL, signal: AbortSignal): Promise<ExtractionResult | null> {
    if (url.hostname !== 'github.com') return null;
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1];
    if (owner === undefined || repo === undefined) return null;
    const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
    const headers: Record<string, string> = {
        accept: 'application/vnd.github.v3+json',
        'user-agent': userAgent(),
    };
    if (token) headers['authorization'] = `Bearer ${token}`;

    // blob → raw content
    if (segments.length >= 4 && segments[2] === 'blob') {
        const ref = segments[3];
        const path = segments.slice(4).join('/');
        if (ref !== undefined) {
            const raw = await fetchText(
                `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
                signal,
                headers,
            );
            if (raw !== undefined) {
                return { url: url.href, markdown: truncate(raw, MAX_EXTRACT_CHARS), method: 'github-raw' };
            }
        }
    }

    // repo overview via API
    const meta = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, signal, headers);
    if (meta === undefined) return null;
    const lines: string[] = [`# ${asString(meta['full_name']) ?? `${owner}/${repo}`}`];
    const description = asString(meta['description']);
    if (description) lines.push('', description);
    const stars = asNumber(meta['stargazers_count']);
    const forks = asNumber(meta['forks_count']);
    const language = asString(meta['language']);
    const license = asRecord(meta['license']);
    const metaParts: string[] = [];
    if (stars !== undefined) metaParts.push(`Stars: ${stars.toLocaleString()}`);
    if (forks !== undefined) metaParts.push(`Forks: ${forks.toLocaleString()}`);
    if (language) metaParts.push(`Language: ${language}`);
    if (license) {
        const spdx = asString(license['spdx_id']);
        if (spdx && spdx !== 'NOASSERTION') metaParts.push(`License: ${spdx}`);
    }
    if (metaParts.length > 0) lines.push('', metaParts.join(' · '));
    const homepage = asString(meta['homepage']);
    if (homepage) lines.push('', `**Homepage:** ${homepage}`);
    const topics = asArray(meta['topics']);
    if (topics && topics.length > 0) {
        lines.push(
            `**Topics:** ${topics
                .map((t) => asString(t) ?? '')
                .filter((s) => s.length > 0)
                .join(', ')}`,
        );
    }
    // README
    const readme = await fetchText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${asString(meta['default_branch']) ?? 'HEAD'}/README.md`,
        signal,
        headers,
    );
    if (readme !== undefined && readme.trim().length > 0) {
        lines.push('', '---', '', '## README', '', truncate(readme, 8000));
    }
    return { url: url.href, markdown: lines.join('\n'), method: 'github' };
}

async function handleGitLab(url: URL, signal: AbortSignal): Promise<ExtractionResult | null> {
    if (url.hostname !== 'gitlab.com') return null;
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    const projectPath = encodeURIComponent(segments.slice(0, 2).join('/'));
    const meta = await fetchJson(`https://gitlab.com/api/v4/projects/${projectPath}`, signal);
    if (meta === undefined) return null;
    const lines: string[] = [`# ${asString(meta['path_with_namespace']) ?? segments.join('/')}`];
    const description = asString(meta['description']);
    if (description) lines.push('', description);
    const stars = asNumber(meta['star_count']);
    const forks = asNumber(meta['forks_count']);
    const metaParts: string[] = [];
    if (stars !== undefined) metaParts.push(`Stars: ${stars.toLocaleString()}`);
    if (forks !== undefined) metaParts.push(`Forks: ${forks.toLocaleString()}`);
    if (metaParts.length > 0) lines.push('', metaParts.join(' · '));
    const web = asString(meta['web_url']);
    if (web) lines.push('', `**URL:** ${web}`);
    const readme = asString(meta['readme_url']);
    if (readme) lines.push(`**README:** ${readme}`);
    return { url: url.href, markdown: lines.join('\n'), method: 'gitlab' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(
    url: string,
    signal: AbortSignal,
    headers?: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(url, {
        signal,
        headers: { accept: 'application/json', 'user-agent': userAgent(), ...(headers ?? {}) },
    });
    if (!response.ok) return undefined;
    try {
        const json = await response.json();
        return typeof json === 'object' && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

async function fetchText(
    url: string,
    signal: AbortSignal,
    headers?: Record<string, string>,
): Promise<string | undefined> {
    const response = await fetch(url, {
        signal,
        headers: { accept: 'text/plain, text/markdown, */*', 'user-agent': userAgent(), ...(headers ?? {}) },
    });
    if (!response.ok) return undefined;
    try {
        return await response.text();
    } catch {
        return undefined;
    }
}

function linkSignals(outer: AbortSignal, inner: AbortController): AbortSignal {
    if (outer.aborted) {
        inner.abort();
        return outer;
    }
    outer.addEventListener('abort', () => inner.abort(), { once: true });
    return inner.signal;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function userAgent(): string {
    return 'mission-control-web-search/1.0';
}

function stripTags(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
function asArray(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}
function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
