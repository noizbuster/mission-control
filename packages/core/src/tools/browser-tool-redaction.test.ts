import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeAdvertisementToAiSdk } from '../behavior/nodes/llm-actor/abg-tool-bridge';
import type { BrowserConnectFn, BrowserPageSeam } from './browser-tool';
import { createBrowserToolRegistration } from './browser-tool';
import { BrowserHarness, toolContext } from './browser-tool-lifecycle-test-support';
import {
    browserToolContext,
    browserToolOptions,
    cleanupBrowserToolWorkspaces,
    mockBrowserCdp,
    projectTrustReader,
} from './browser-tool-test-support';
import { browserEndpointRedactionSecrets } from './browser-tool-url';
import { ToolRegistry } from './tool-registry';
import { ToolExecutionError } from './tool-registry-types';

describe('browser tool redaction', () => {
    afterEach(cleanupBrowserToolWorkspaces);

    it('redacts configured secrets from extracted text', async () => {
        const secret = 'SUPER_SECRET_TOKEN_123';
        const cdp = mockBrowserCdp({ text: `The token is ${secret} here.` });
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect: cdp.connect, redactionSecrets: [secret] }),
        );
        const output = await registration?.execute(
            { action: 'navigate', url: 'https://secret.test' },
            browserToolContext(),
        );
        expect(output?.text).not.toContain(secret);
    });

    it('redacts configured secrets from returned page URLs and titles', async () => {
        const secret = ['browser', 'metadata', 'credential'].join('_');
        const cdp = mockBrowserCdp({
            url: `https://redirect.test/?token=${secret}`,
            title: `Account ${secret}`,
            text: 'ordinary page text',
        });
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect: cdp.connect, redactionSecrets: [secret] }),
        );
        const output = await registration?.execute(
            { action: 'navigate', url: 'https://redirect.test' },
            browserToolContext(),
        );
        expect(JSON.stringify(output)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(output)).not.toContain(secret);
    });

    it('redacts configured secrets from CDP connection failures', async () => {
        const secret = ['browser', 'connection', 'credential'].join('_');
        const connect: BrowserConnectFn = async () => {
            throw new Error(`connection rejected ${secret}`);
        };
        const registration = createBrowserToolRegistration({
            ...(await browserToolOptions({ connect, redactionSecrets: [secret] })),
            endpoint: { browserURL: `http://127.0.0.1:9222/?token=${secret}` },
        });
        const failure = registration?.execute(
            { action: 'navigate', url: 'https://example.test' },
            browserToolContext(),
        );
        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.toThrow('[REDACTED_CREDENTIAL]');
    });

    it('redacts a configured CDP endpoint pathname from connector failures', async () => {
        const secret = ['browser', 'endpoint', 'identifier'].join('_');
        const endpoint = { browserWSEndpoint: `ws://127.0.0.1:9222/devtools/browser/${secret}` } as const;
        const endpointPath = new URL(endpoint.browserWSEndpoint).pathname;
        const connect: BrowserConnectFn = async () => {
            throw new Error(`connection rejected at ${endpointPath}`);
        };
        const registration = createBrowserToolRegistration({
            ...(await browserToolOptions({ connect, redactionSecrets: browserEndpointRedactionSecrets(endpoint) })),
            endpoint,
        });

        const failure = registration.execute({ action: 'extract' }, browserToolContext());

        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.not.toThrow(endpointPath);
        await expect(failure).rejects.toThrow('[REDACTED_CREDENTIAL]');
    });

    it('redacts configured secrets when navigate text and HTML extraction both fail', async () => {
        const secret = ['browser', 'extraction', 'credential'].join('_');
        const connect: BrowserConnectFn = async () => ({
            connected: true,
            async newPage(): Promise<BrowserPageSeam> {
                return {
                    async goto() {},
                    url: () => 'https://example.test',
                    title: async () => '',
                    extractText: async () => {
                        throw new Error('text extraction failed');
                    },
                    extractHtml: async () => {
                        throw new Error(`HTML extraction failed with ${secret}`);
                    },
                    screenshot: async () => new Uint8Array(),
                    async close() {},
                };
            },
            async disconnect() {},
        });
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect, redactionSecrets: [secret] }),
        );
        const failure = registration?.execute(
            { action: 'navigate', url: 'https://example.test' },
            browserToolContext(),
        );
        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.toThrow('[REDACTED_CREDENTIAL]');
    });

    it('redacts injected ToolExecutionError messages and events from CDP connection failures', async () => {
        const secret = ['browser', 'tool', 'error', 'credential'].join('_');
        const connect: BrowserConnectFn = async () => {
            throw new ToolExecutionError({ code: 'tool_failed', message: `connector ${secret}`, retryable: true }, [
                { type: 'log', timestamp: '2026-07-13T00:00:00.000Z', message: `event ${secret}` },
            ]);
        };
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect, redactionSecrets: [secret] }),
        );
        const failure = registration?.execute(
            { action: 'navigate', url: 'https://example.test' },
            browserToolContext(),
        );
        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.toMatchObject({
            message: expect.stringContaining('[REDACTED_CREDENTIAL]'),
            events: [expect.objectContaining({ message: expect.stringContaining('[REDACTED_CREDENTIAL]') })],
        });
    });

    it('redacts configured secrets from approval failure reasons', async () => {
        const secret = ['browser', 'approval', 'credential'].join('_');
        const cdp = mockBrowserCdp();
        const registration = createBrowserToolRegistration(
            await browserToolOptions({
                connect: cdp.connect,
                redactionSecrets: [secret],
                requestPermission: async () => ({ requestId: 'request_browser', status: 'deny', reason: secret }),
            }),
        );
        const failure = registration?.execute(
            { action: 'navigate', url: `https://example.test/?token=${secret}` },
            browserToolContext(),
        );
        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.toThrow('[REDACTED_CREDENTIAL]');
    });

    it.each([
        'ordinary Error',
        'ToolExecutionError',
    ] as const)('redacts navigation-derived secrets from returned errors, events, and model output for $type', async (type) => {
        const fixture = navigationLeakFixture();
        const errorText = `browser echoed ${fixture.url}; decoded ${fixture.decodedValue}; fragment ${fixture.decodedFragment}`;
        const operationError = new ToolExecutionError(
            {
                code: 'tool_failed',
                message: errorText,
                retryable: false,
                redactions: [{ classification: 'secret', reason: errorText, replacement: errorText }],
            },
            [{ type: 'log', timestamp: '2026-07-14T00:00:00.000Z', message: errorText }],
        );
        const harness = new BrowserHarness(
            type === 'ToolExecutionError'
                ? { actionToolErrors: { navigate: operationError } }
                : {
                      gotoHook: async () => {
                          throw new Error(errorText);
                      },
                  },
        );
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
            connect: harness.connect,
        });
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration);

        const settlement = await registry.invoke({
            toolCallId: 'browser-error-call',
            toolName: advertisement.name,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ action: 'navigate', url: fixture.url }),
        });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement);
        if (bridged.execute === undefined) throw new Error('bridged browser tool is missing execute');
        const modelOutput = await bridged.execute(
            { action: 'navigate', url: fixture.url },
            {
                toolCallId: 'browser-model-error-call',
                messages: [] as ModelMessage[],
                abortSignal: toolContext().signal,
                context: {} as never,
            },
        );
        await registration.close();
        const observable = JSON.stringify({
            returnedError: settlement.result.error,
            events: settlement.events,
            modelOutput,
        });

        expectNavigationSecretsRedacted(observable, fixture);
        expect(observable).toContain('example.test');
        expect(observable).toContain('/useful/path');
        expect(observable).toContain('token=');
        expect(observable).toContain('encoded=');
    });
});

type NavigationLeakFixture = {
    readonly decodedFragment: string;
    readonly decodedValue: string;
    readonly secrets: readonly string[];
    readonly url: string;
};

function navigationLeakFixture(): NavigationLeakFixture {
    const decodedValue = 'encoded/query?secret';
    const encodedValue = encodeURIComponent(decodedValue);
    const decodedFragment = 'fragment/secret';
    const encodedFragment = encodeURIComponent(decodedFragment);
    const secrets = [
        'browser-user',
        'browser-password',
        'first-query-secret',
        'second-query-secret',
        decodedValue,
        encodedValue,
        decodedFragment,
        encodedFragment,
    ] as const;
    return {
        decodedFragment,
        decodedValue,
        secrets,
        url:
            `https://browser-user:browser-password@example.test/useful/path` +
            `?token=first-query-secret&token=second-query-secret&encoded=${encodedValue}#${encodedFragment}`,
    };
}

function expectNavigationSecretsRedacted(observable: string, fixture: NavigationLeakFixture): void {
    expect(observable).toContain('[REDACTED_CREDENTIAL]');
    expect(observable).not.toContain(fixture.url);
    for (const secret of fixture.secrets) expect(observable).not.toContain(secret);
}
