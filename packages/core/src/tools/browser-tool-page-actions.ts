import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { BrowserConnectionManager } from './browser-tool-connection-manager.js';
import type { BrowserInput, BrowserOutput } from './browser-tool-contract.js';
import { redactBrowserToolError } from './browser-tool-error-redaction.js';
import { browserFailure, browserOutput, capScreenshot } from './browser-tool-output.js';
import type { BrowserPageSeam } from './browser-tool-puppeteer.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';

type BrowserPageActionOptions = {
    readonly maxModelOutputChars: number;
    readonly maxScreenshotBytes: number;
    readonly observabilityRedactor: ObservabilityRedactor;
    readonly requireLiveAuthority: () => Promise<void>;
};

export async function runExtract(
    options: BrowserPageActionOptions,
    input: BrowserInput,
    signal: AbortSignal,
    connectionManager: BrowserConnectionManager,
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    const format = input.format ?? 'text';
    let page: BrowserPageSeam | undefined;
    try {
        page = await connectionManager.acquirePage(signal, options.observabilityRedactor);
        await options.requireLiveAuthority();
        const raw = await connectionManager.raceAction(
            format === 'html' ? page.extractHtml() : page.extractText(),
            signal,
            'browser extraction',
        );
        const title = await readBrowserTitle(page, signal, connectionManager);
        const limited = truncateOutput(options.observabilityRedactor.redactText(raw), options.maxModelOutputChars);
        return browserOutput('extract', page, {
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
            return browserOutput('extract', page, {
                status: 'timed_out',
                started,
                redactText: options.observabilityRedactor.redactText,
            });
        }
        if (error instanceof ToolExecutionError) {
            throw redactBrowserToolError(error, options.observabilityRedactor);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw browserFailure(options.observabilityRedactor.redactText(`extraction failed: ${message}`));
    }
}

export async function runScreenshot(
    options: BrowserPageActionOptions,
    signal: AbortSignal,
    connectionManager: BrowserConnectionManager,
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    let page: BrowserPageSeam | undefined;
    try {
        page = await connectionManager.acquirePage(signal, options.observabilityRedactor);
        await options.requireLiveAuthority();
        const bytes = await connectionManager.raceAction(page.screenshot(), signal, 'browser screenshot');
        const capped = capScreenshot(bytes, options.maxScreenshotBytes);
        const title = await readBrowserTitle(page, signal, connectionManager);
        return browserOutput('screenshot', page, {
            status: 'completed',
            started,
            title,
            screenshotBase64: capped.base64,
            screenshotBytes: capped.bytes,
            redactText: options.observabilityRedactor.redactText,
        });
    } catch (error: unknown) {
        if (isTimedOut()) {
            return browserOutput('screenshot', page, {
                status: 'timed_out',
                started,
                redactText: options.observabilityRedactor.redactText,
            });
        }
        if (error instanceof ToolExecutionError) {
            throw redactBrowserToolError(error, options.observabilityRedactor);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw browserFailure(options.observabilityRedactor.redactText(`screenshot failed: ${message}`));
    }
}

export async function readBrowserTitle(
    page: BrowserPageSeam,
    signal: AbortSignal,
    connectionManager: BrowserConnectionManager,
): Promise<string> {
    try {
        return await connectionManager.raceAction(page.title(), signal, 'browser title');
    } catch (error: unknown) {
        if (signal.aborted) throw error;
        return '';
    }
}
