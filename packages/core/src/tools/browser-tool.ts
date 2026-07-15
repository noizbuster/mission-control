import { z } from 'zod';
import { createObservabilityRedactor } from '../providers/observability-redactor.js';
import { BrowserConnectionManager } from './browser-tool-connection-manager.js';
import {
    BROWSER_TOOL_DESCRIPTION,
    BROWSER_TOOL_GUIDELINE,
    BROWSER_TOOL_NAME,
    type BrowserInput,
    type BrowserOutput,
    type BrowserToolOptions,
    browserInputSchema,
    browserOutputSchema,
    browserParametersJsonSchema,
    DEFAULT_MAX_MODEL_OUTPUT_CHARS,
    DEFAULT_MAX_SCREENSHOT_BYTES,
    DEFAULT_PROTOCOL_TIMEOUT_MS,
    DEFAULT_VIEWPORT,
    type ResolvedBrowserToolOptions,
} from './browser-tool-contract.js';
import { runBrowserTool } from './browser-tool-execution.js';
import { browserModelOutput } from './browser-tool-output.js';
import { createPuppeteerCoreConnector } from './browser-tool-puppeteer.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';

export {
    type BrowserInput,
    type BrowserOutput,
    type BrowserToolOptions,
    browserInputSchema,
    browserOutputSchema,
} from './browser-tool-contract.js';
export {
    type BrowserConnectFn,
    type BrowserConnectionSeam,
    type BrowserConnectRuntimeOptions,
    type BrowserPageSeam,
    type BrowserWaitUntil,
    createPuppeteerCoreConnector,
} from './browser-tool-puppeteer.js';

export type BrowserToolLifecycle = {
    readonly reset: () => Promise<void>;
    readonly close: () => Promise<void>;
    readonly getCleanupErrors: () => readonly string[];
};

export type BrowserToolRegistration = ToolRegistration<BrowserInput, BrowserOutput> & BrowserToolLifecycle;
export type BrowserToolAdvertisement = ToolAdvertisement & BrowserToolLifecycle;

export async function registerBrowserTool(
    registry: ToolRegistry,
    options: BrowserToolOptions,
): Promise<BrowserToolAdvertisement> {
    const registration = createBrowserToolRegistration(options);
    return {
        ...registry.register(registration),
        reset: registration.reset,
        close: registration.close,
        getCleanupErrors: registration.getCleanupErrors,
    };
}

export function createBrowserToolRegistration(options: BrowserToolOptions): BrowserToolRegistration {
    const resolved = resolveOptions(options);
    const connectionManager = new BrowserConnectionManager(resolved);
    return {
        name: BROWSER_TOOL_NAME,
        description: BROWSER_TOOL_DESCRIPTION,
        capabilityClasses: ['network', 'exec'],
        parametersJsonSchema: browserParametersJsonSchema(),
        inputSchema: browserInputSchema as z.ZodType<BrowserInput>,
        outputSchema: browserOutputSchema as z.ZodType<BrowserOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runBrowserTool(resolved, input, context, connectionManager),
        toModelOutput: browserModelOutput,
        guideline: BROWSER_TOOL_GUIDELINE,
        reset: () => connectionManager.reset(),
        close: () => connectionManager.close(),
        getCleanupErrors: () => connectionManager.getCleanupErrors(),
    };
}

function resolveOptions(options: BrowserToolOptions): ResolvedBrowserToolOptions {
    const observabilityRedactor = createObservabilityRedactor({ secrets: options.redactionSecrets ?? [] });
    return {
        workspaceRoot: options.workspaceRoot,
        projectTrustStore: options.projectTrustStore,
        endpoint: options.endpoint,
        connect: options.connect ?? createPuppeteerCoreConnector(),
        requestPermission: options.requestPermission,
        protocolTimeoutMs: options.protocolTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS,
        defaultViewport: options.defaultViewport ?? DEFAULT_VIEWPORT,
        maxModelOutputChars: options.maxModelOutputChars ?? DEFAULT_MAX_MODEL_OUTPUT_CHARS,
        maxScreenshotBytes: options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES,
        observabilityRedactor,
    };
}
