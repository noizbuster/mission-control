import type { BrowserConfig } from '@mission-control/protocol';
import type { Browser as PuppeteerBrowserLike, Page as PuppeteerPageLike } from 'puppeteer-core';
import { raceBrowserCleanup } from './browser-tool-deadline.js';
import { browserFailure } from './browser-tool-output.js';

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export interface BrowserPageSeam {
    readonly closed?: boolean;
    goto(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number, signal: AbortSignal): Promise<void>;
    url(): string;
    title(): Promise<string>;
    extractText(): Promise<string>;
    extractHtml(): Promise<string>;
    screenshot(): Promise<Uint8Array>;
    close(): Promise<void>;
}

export interface BrowserConnectionSeam {
    readonly connected: boolean;
    newPage(): Promise<BrowserPageSeam>;
    onDisconnected?(listener: () => void): () => void;
    disconnect(): Promise<void>;
}

export interface BrowserConnectRuntimeOptions {
    readonly protocolTimeoutMs: number;
    readonly defaultViewport: { readonly width: number; readonly height: number };
}

export type BrowserConnectFn = (
    endpoint: BrowserConfig,
    options: BrowserConnectRuntimeOptions,
    signal: AbortSignal,
) => Promise<BrowserConnectionSeam>;

type PuppeteerCoreConnectable = typeof import('puppeteer-core')['default'];

let cachedPuppeteerCore: PuppeteerCoreConnectable | undefined;

async function loadPuppeteerCore(): Promise<PuppeteerCoreConnectable> {
    if (cachedPuppeteerCore !== undefined) {
        return cachedPuppeteerCore;
    }
    const module = await import('puppeteer-core');
    cachedPuppeteerCore = module.default;
    return module.default;
}

export function createPuppeteerCoreConnector(): BrowserConnectFn {
    return async (endpoint, options, signal) => {
        let puppeteer: PuppeteerCoreConnectable;
        try {
            puppeteer = await loadPuppeteerCore();
        } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            throw browserFailure(`failed to load the browser runtime dependency puppeteer-core: ${detail}`);
        }
        const browser = await puppeteer.connect({
            ...endpoint,
            defaultViewport: options.defaultViewport,
            protocolTimeout: options.protocolTimeoutMs,
        });
        if (signal.aborted) {
            await disconnectAbortedBrowser(browser, options.protocolTimeoutMs);
            throw browserFailure('browser connection aborted');
        }
        return wrapPuppeteerBrowser(browser);
    };
}

function wrapPuppeteerBrowser(browser: PuppeteerBrowserLike): BrowserConnectionSeam {
    return {
        get connected(): boolean {
            return browser.connected;
        },
        async newPage() {
            const page = await browser.newPage();
            return wrapPuppeteerPage(page);
        },
        onDisconnected(listener) {
            browser.on('disconnected', listener);
            return () => browser.off('disconnected', listener);
        },
        disconnect: () => browser.disconnect(),
    };
}

function wrapPuppeteerPage(page: PuppeteerPageLike): BrowserPageSeam {
    return {
        get closed(): boolean {
            return page.isClosed();
        },
        async goto(url, waitUntil, timeoutMs, signal) {
            if (signal.aborted) throw browserFailure('navigation aborted');
            await page.goto(url, { waitUntil, timeout: timeoutMs });
        },
        url: () => page.url(),
        title: () => page.title(),
        extractText: () => page.evaluate(() => document.body?.innerText ?? ''),
        extractHtml: () => page.content(),
        screenshot: () => page.screenshot(),
        close: () => page.close(),
    };
}

async function disconnectAbortedBrowser(browser: PuppeteerBrowserLike, protocolTimeoutMs: number): Promise<void> {
    try {
        if (browser.connected) {
            await raceBrowserCleanup(browser.disconnect(), protocolTimeoutMs, 'browser disconnect');
        }
    } catch (error: unknown) {
        if (!(error instanceof Error)) throw error;
        throw browserFailure('browser connection aborted; disconnect failed');
    }
}
