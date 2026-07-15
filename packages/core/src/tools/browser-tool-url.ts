import type { BrowserConfig } from '@mission-control/protocol';
import { browserEndpointValue } from './browser-tool-contract.js';
import { createHash } from 'node:crypto';

export function observableBrowserUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        const rawWithoutQueryOrFragment = rawUrl.split(/[?#]/u, 1)[0] ?? rawUrl;
        const omittedRootSlash = url.pathname === '/' && !rawWithoutQueryOrFragment.endsWith('/');
        url.username = '';
        url.password = '';
        for (const key of new Set(url.searchParams.keys())) {
            url.searchParams.set(key, '[REDACTED]');
        }
        url.hash = '';
        const observableUrl = url.toString();
        return omittedRootSlash
            ? observableUrl.replace(`${url.protocol}//${url.host}/`, `${url.protocol}//${url.host}`)
            : observableUrl;
    } catch {
        return '<invalid-url>';
    }
}

export function browserNavigationRedactionSecrets(rawUrl: string): readonly string[] {
    const url = new URL(rawUrl);
    const secrets = new Set<string>();
    addUrlComponentVariants(secrets, url.username);
    addUrlComponentVariants(secrets, url.password);
    for (const value of url.searchParams.values()) addUrlComponentVariants(secrets, value);
    for (const parameter of url.search.slice(1).split('&')) {
        const separator = parameter.indexOf('=');
        if (separator >= 0) addUrlComponentVariants(secrets, parameter.slice(separator + 1));
    }
    addUrlComponentVariants(secrets, url.hash.slice(1));
    return [...secrets];
}

export function browserEndpointRedactionSecrets(endpoint: BrowserConfig): readonly string[] {
    const rawEndpoint = browserEndpointValue(endpoint);
    const secrets = new Set<string>([rawEndpoint]);
    const url = new URL(rawEndpoint);
    if (url.username.length > 0) secrets.add(url.username);
    if (url.password.length > 0) secrets.add(url.password);
    if (url.pathname !== '/') secrets.add(url.pathname);
    for (const value of url.searchParams.values()) {
        if (value.length > 0) secrets.add(value);
    }
    if (url.hash.length > 1) secrets.add(url.hash.slice(1));
    return [...secrets];
}

export function observableBrowserEndpoint(endpoint: BrowserConfig): string {
    const url = new URL(browserEndpointValue(endpoint));
    return `${url.protocol}//${url.host}/<redacted-endpoint>`;
}

export function browserPermissionPattern(rawUrl: string): string {
    return `browser:sha256:${createHash('sha256').update(rawUrl, 'utf8').digest('hex')}`;
}

function addUrlComponentVariants(secrets: Set<string>, value: string): void {
    if (value.length === 0) return;
    secrets.add(value);
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch (error: unknown) {
        if (error instanceof URIError) return;
        throw error;
    }
    if (decoded.length === 0) return;
    secrets.add(decoded);
    secrets.add(encodeURIComponent(decoded));
}
