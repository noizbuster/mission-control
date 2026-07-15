import type { PermissionDecision } from '@mission-control/protocol';
import {
    type BrowserInput,
    type BrowserOutput,
    browserEndpointValue,
    type ResolvedBrowserToolOptions,
} from './browser-tool-contract.js';
import { redactBrowserToolError } from './browser-tool-error-redaction.js';
import type { BrowserPageSeam } from './browser-tool-puppeteer.js';
import { browserPermissionPattern, observableBrowserEndpoint, observableBrowserUrl } from './browser-tool-url.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { ToolExecutionError } from './tool-registry-types.js';

const BASE64_SAFETY_MARGIN = 1.5;

type BrowserResultInput = {
    readonly status: BrowserOutput['status'];
    readonly started: number;
    readonly title?: string;
    readonly text?: string;
    readonly truncated?: boolean;
    readonly originalLength?: number;
    readonly screenshotBase64?: string;
    readonly screenshotBytes?: number;
    readonly redactText: (text: string) => string;
};

export function browserOutput(
    action: BrowserOutput['action'],
    page: BrowserPageSeam | undefined,
    input: BrowserResultInput,
): BrowserOutput {
    const text = input.text ?? '';
    const result: BrowserOutput = {
        kind: 'browser',
        action,
        url: input.redactText(safePageUrl(page)),
        title: input.redactText(input.title ?? ''),
        status: input.status,
        truncated: input.truncated ?? false,
        originalLength: input.originalLength ?? text.length,
        returnedLength: text.length,
        durationMs: Date.now() - input.started,
    };
    if (text.length > 0) {
        return { ...result, text: input.redactText(text) };
    }
    if (input.screenshotBase64 !== undefined && input.screenshotBytes !== undefined) {
        return { ...result, screenshotBase64: input.screenshotBase64, screenshotBytes: input.screenshotBytes };
    }
    return result;
}

export function browserModelOutput(output: BrowserOutput): string {
    if (output.action === 'screenshot') {
        const lines = [`## browser screenshot (${output.screenshotBytes ?? 0} bytes)`];
        lines.push(`URL: ${output.url}`);
        if (output.truncated) lines.push('[screenshot capped]');
        return lines.join('\n');
    }
    const lines = [`## browser ${output.action}: ${output.url}`];
    if (output.text !== undefined && output.text.length > 0) {
        lines.push(output.text);
    } else if (output.status !== 'completed') {
        lines.push(`[${output.status}]`);
    }
    if (output.truncated) {
        lines.push('[output truncated]');
    }
    return lines.join('\n');
}

export async function requireBrowserApproval(
    options: ResolvedBrowserToolOptions,
    toolCallId: string,
    action: BrowserInput['action'],
    url: string | undefined,
): Promise<void> {
    const observableUrl = url === undefined ? undefined : observableBrowserUrl(url);
    const rawResource = url ?? browserEndpointValue(options.endpoint);
    const observableResource = observableUrl ?? observableBrowserEndpoint(options.endpoint);
    const reason = `browser ${action}: ${observableResource}`;
    const request = permissionRequest({
        toolCallId,
        action: 'browser',
        reason,
        permission: 'network',
        patterns: [browserPermissionPattern(rawResource)],
        workspaceRoot: options.workspaceRoot,
    });
    let decision: PermissionDecision;
    try {
        decision = await requestToolPermission(options.requestPermission, request);
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
            throw redactBrowserToolError(error, options.observabilityRedactor);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw browserFailure(options.observabilityRedactor.redactText(`browser approval failed: ${detail}`));
    }
    if (decision.status === 'allow') {
        return;
    }
    throw browserFailure(
        options.observabilityRedactor.redactText(
            decision.status === 'deny'
                ? `approval_denied: ${decision.reason ?? 'browser denied'}`
                : `approval_required: ${decision.reason ?? 'browser requires approval'}`,
        ),
    );
}

export function capScreenshot(
    bytes: Uint8Array,
    maxBytes: number,
): { readonly base64: string; readonly bytes: number } {
    if (bytes.byteLength <= maxBytes) {
        return { base64: toBase64(bytes), bytes: bytes.byteLength };
    }
    const limit = Math.max(0, Math.floor(maxBytes / BASE64_SAFETY_MARGIN));
    const slice = bytes.subarray(0, limit);
    return { base64: toBase64(slice), bytes: limit };
}

export function browserFailure(message: string): ToolExecutionError {
    return new ToolExecutionError({
        code: 'tool_failed',
        message,
        retryable: false,
    });
}

function safePageUrl(page: BrowserPageSeam | undefined): string {
    if (page === undefined) return '';
    try {
        return observableBrowserUrl(page.url());
    } catch {
        return '';
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.length);
        binary += String.fromCharCode(...bytes.subarray(offset, end));
    }
    return Buffer.from(binary, 'binary').toString('base64');
}
