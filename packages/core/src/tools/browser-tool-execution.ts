import { composeObservabilityRedactors, createObservabilityRedactor } from '../providers/observability-redactor.js';
import { BrowserConnectionManager } from './browser-tool-connection-manager.js';
import {
    type BrowserInput,
    type BrowserOutput,
    DEFAULT_TIMEOUT_SECONDS,
    type ResolvedBrowserToolOptions,
} from './browser-tool-contract.js';
import { createBrowserAbortScope } from './browser-tool-deadline.js';
import { redactBrowserToolError } from './browser-tool-error-redaction.js';
import { requireBrowserLiveAuthority } from './browser-tool-live-authority.js';
import { browserFailure, browserOutput, requireBrowserApproval } from './browser-tool-output.js';
import { readBrowserTitle, runExtract, runScreenshot } from './browser-tool-page-actions.js';
import type { BrowserPageSeam } from './browser-tool-puppeteer.js';
import { browserNavigationRedactionSecrets, observableBrowserUrl } from './browser-tool-url.js';
import { type ToolExecutionContext, ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';

type BrowserExecutionOptions = ResolvedBrowserToolOptions & {
    readonly requireLiveAuthority: () => Promise<void>;
};

export async function runBrowserTool(
    options: ResolvedBrowserToolOptions,
    input: BrowserInput,
    context: ToolExecutionContext,
    connectionManager: BrowserConnectionManager,
): Promise<BrowserOutput> {
    const requireLiveAuthority = () => requireBrowserLiveAuthority(options, () => connectionManager.reset());
    await requireLiveAuthority();
    const navigationUrl = input.action === 'navigate' ? requireBrowserNavigationUrl(input.url) : undefined;
    const executionOptions: BrowserExecutionOptions = {
        ...options,
        requireLiveAuthority,
        observabilityRedactor:
            navigationUrl === undefined
                ? options.observabilityRedactor
                : composeObservabilityRedactors([
                      options.observabilityRedactor,
                      createObservabilityRedactor({ secrets: browserNavigationRedactionSecrets(navigationUrl) }),
                  ]),
    };
    await requireBrowserApproval(executionOptions, context.toolCallId, input.action, navigationUrl);
    await requireLiveAuthority();

    const started = Date.now();
    const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const abortScope = createBrowserAbortScope(context.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortScope.abort();
    }, timeoutMs);

    try {
        return await connectionManager.runExclusive(abortScope.signal, async (actionSignal) => {
            await requireLiveAuthority();
            try {
                let output: BrowserOutput;
                if (input.action === 'navigate') {
                    output = await runNavigate(
                        executionOptions,
                        input,
                        navigationUrl ?? requireBrowserNavigationUrl(input.url),
                        actionSignal,
                        connectionManager,
                        started,
                        () => timedOut,
                    );
                } else if (input.action === 'screenshot') {
                    output = await runScreenshot(
                        executionOptions,
                        actionSignal,
                        connectionManager,
                        started,
                        () => timedOut,
                    );
                } else {
                    output = await runExtract(
                        executionOptions,
                        input,
                        actionSignal,
                        connectionManager,
                        started,
                        () => timedOut,
                    );
                }
                if (output.status === 'timed_out') await connectionManager.reset();
                return output;
            } catch (error: unknown) {
                await connectionManager.reset();
                throw error;
            }
        });
    } catch (error: unknown) {
        if (timedOut) {
            return browserOutput(input.action, undefined, {
                status: 'timed_out',
                started,
                redactText: options.observabilityRedactor.redactText,
            });
        }
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
        abortScope.dispose();
    }
}

async function runNavigate(
    options: BrowserExecutionOptions,
    input: BrowserInput,
    url: string,
    signal: AbortSignal,
    connectionManager: BrowserConnectionManager,
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    let page: BrowserPageSeam | undefined;
    const waitUntil = input.waitUntil ?? 'load';
    const navTimeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    try {
        page = await connectionManager.acquirePage(signal, options.observabilityRedactor);
        await options.requireLiveAuthority();
        await connectionManager.raceAction(
            page.goto(url, waitUntil, navTimeoutMs, signal),
            signal,
            'browser navigation',
        );
        const raw = await safeExtractText(page, options.observabilityRedactor.redactText, signal, connectionManager);
        const title = await readBrowserTitle(page, signal, connectionManager);
        const limited = truncateOutput(options.observabilityRedactor.redactText(raw), options.maxModelOutputChars);
        return browserOutput('navigate', page, {
            status: 'completed',
            started,
            title,
            text: limited.content,
            truncated: limited.truncated,
            originalLength: limited.originalLength,
            redactText: options.observabilityRedactor.redactText,
        });
    } catch (error: unknown) {
        if (isTimedOut()) {
            return browserOutput('navigate', page, {
                status: 'timed_out',
                started,
                redactText: options.observabilityRedactor.redactText,
            });
        }
        if (error instanceof ToolExecutionError) {
            throw redactBrowserToolError(error, options.observabilityRedactor);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw browserFailure(
            options.observabilityRedactor.redactText(`navigation to ${observableBrowserUrl(url)} failed: ${message}`),
        );
    }
}

function requireBrowserNavigationUrl(rawUrl: string | undefined): string {
    if (rawUrl === undefined) throw browserFailure('action "navigate" requires a "url"');
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw browserFailure('browser navigation URL must be valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw browserFailure('browser navigation URL must use http or https');
    }
    return rawUrl;
}

async function safeExtractText(
    page: BrowserPageSeam,
    redactText: (text: string) => string,
    signal: AbortSignal,
    connectionManager: BrowserConnectionManager,
): Promise<string> {
    try {
        return await connectionManager.raceAction(page.extractText(), signal, 'browser text extraction');
    } catch (error: unknown) {
        if (signal.aborted) throw error;
        try {
            return await connectionManager.raceAction(page.extractHtml(), signal, 'browser HTML extraction');
        } catch (fallbackError: unknown) {
            const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw browserFailure(redactText(`extraction failed: ${message}`));
        }
    }
}
