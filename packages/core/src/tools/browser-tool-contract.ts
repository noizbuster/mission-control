import type { BrowserConfig, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import type { ProjectTrustReader } from '../trust/project-trust-store';
import type { BrowserConnectFn } from './browser-tool-puppeteer';

export const BROWSER_TOOL_NAME = 'browser';
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_MODEL_OUTPUT_CHARS = 16_000;
export const DEFAULT_MAX_SCREENSHOT_BYTES = 256 * 1024;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export const BROWSER_TOOL_DESCRIPTION =
    'Drive a real browser over the Chrome DevTools Protocol (CDP). Attaches to a user-supplied Chrome ' +
    'exposed via a CDP endpoint; does NOT download or launch Chromium. Three actions:\n' +
    '- navigate (default): open a URL, wait for load, and return the page title + readable text.\n' +
    '- extract: re-extract readable text or HTML from the currently loaded page (no navigation).\n' +
    '- screenshot: capture a screenshot as base64 (byte-capped).';

export const BROWSER_TOOL_GUIDELINE =
    'Use the browser tool to read live web pages that local files, webfetch, or search cannot answer. ' +
    'Prefer navigate (which returns readable text in one call) over manual extract. Screenshots are byte-capped ' +
    'and count against the output budget — use text extraction first. Requires a trusted workspace and approval.';

export const browserInputSchema = z
    .object({
        action: z.enum(['navigate', 'extract', 'screenshot']),
        url: z
            .url()
            .max(8_192)
            .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
                message: 'browser navigation URL must use http or https',
            })
            .optional(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional(),
        format: z.enum(['text', 'html']).optional(),
        timeout: z.number().int().positive().max(300).optional(),
    })
    .strict();
export type BrowserInput = z.infer<typeof browserInputSchema>;

export const browserOutputSchema = z
    .object({
        kind: z.literal('browser'),
        action: z.enum(['navigate', 'extract', 'screenshot']),
        url: z.string(),
        title: z.string(),
        status: z.enum(['completed', 'failed', 'timed_out']),
        text: z.string().optional(),
        truncated: z.boolean(),
        originalLength: z.number().int().nonnegative(),
        returnedLength: z.number().int().nonnegative(),
        screenshotBase64: z.string().optional(),
        screenshotBytes: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative(),
    })
    .strict();
export type BrowserOutput = z.infer<typeof browserOutputSchema>;

export type BrowserToolOptions = {
    readonly workspaceRoot: string;
    readonly projectTrustStore: ProjectTrustReader;
    readonly endpoint: BrowserConfig;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly connect?: BrowserConnectFn;
    readonly protocolTimeoutMs?: number;
    readonly defaultViewport?: { readonly width: number; readonly height: number };
    readonly maxModelOutputChars?: number;
    readonly maxScreenshotBytes?: number;
    readonly redactionSecrets?: readonly string[];
};

export type ResolvedBrowserToolOptions = {
    readonly workspaceRoot: string;
    readonly projectTrustStore: ProjectTrustReader;
    readonly endpoint: BrowserConfig;
    readonly connect: BrowserConnectFn;
    readonly requestPermission: BrowserToolOptions['requestPermission'];
    readonly protocolTimeoutMs: number;
    readonly defaultViewport: { readonly width: number; readonly height: number };
    readonly maxModelOutputChars: number;
    readonly maxScreenshotBytes: number;
    readonly observabilityRedactor: ObservabilityRedactor;
};

export function browserEndpointValue(endpoint: BrowserConfig): string {
    return 'browserURL' in endpoint ? endpoint.browserURL : endpoint.browserWSEndpoint;
}

export function browserParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['navigate', 'extract', 'screenshot'],
                description:
                    'Operation: navigate (open URL + extract text), extract (text/html from current page), or screenshot.',
            },
            url: { type: 'string', description: 'URL to navigate to (required for action "navigate").' },
            waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
                description: 'Navigation wait condition (default "load").',
            },
            format: {
                type: 'string',
                enum: ['text', 'html'],
                description: 'Extraction format for extract action (default "text").',
            },
            timeout: { type: 'integer', description: 'Per-call timeout in seconds (default 30, max 300).' },
        },
        required: ['action'],
        additionalProperties: false,
    };
}
