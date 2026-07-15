import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserToolRegistration } from './browser-tool.js';
import { BrowserHarness, createRegistration, toolContext } from './browser-tool-lifecycle-test-support.js';
import { projectTrustReader } from './browser-tool-test-support.js';
import { ToolExecutionError } from './tool-registry-types.js';

describe('browser tool adversarial security', () => {
    afterEach(() => vi.useRealTimers());

    it.each([
        { action: 'navigate' as const, input: { action: 'navigate' as const, url: 'https://page-a.test' } },
        { action: 'extract' as const, input: { action: 'extract' as const } },
        { action: 'screenshot' as const, input: { action: 'screenshot' as const } },
    ])('redacts a ToolExecutionError from the $action page operation', async ({ action, input }) => {
        const secret = `${action}_operation_secret`;
        const operationError = secretToolError(secret, 'secret');
        const harness = new BrowserHarness({ actionToolErrors: { [action]: operationError } });
        const registration = createRegistration(harness, { redactionSecrets: [secret] });

        const execution = registration?.execute(input, toolContext());

        await expect(execution).rejects.not.toThrow(secret);
        await expectRedactedToolError(execution);
    });

    it('redacts a typed permission resolver failure before connection acquisition', async () => {
        const secret = 'permission_resolver_secret';
        const resolverError = secretToolError(secret, 'credential');
        const harness = new BrowserHarness();
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: () => {
                throw resolverError;
            },
            connect: harness.connect,
            redactionSecrets: [secret],
        });

        const execution = registration?.execute({ action: 'extract' }, toolContext());

        await expectRedactedToolError(execution);
        expect(harness.connections).toHaveLength(0);
    });

    it('normalizes and redacts an ordinary permission resolver exception', async () => {
        const secret = 'ordinary_permission_secret';
        const harness = new BrowserHarness();
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: () => {
                throw new Error(secret);
            },
            connect: harness.connect,
            redactionSecrets: [secret],
        });

        const execution = registration?.execute({ action: 'extract' }, toolContext());

        await expect(execution).rejects.not.toThrow(secret);
        await expect(execution).rejects.toThrow('[REDACTED_CREDENTIAL]');
        expect(harness.connections).toHaveLength(0);
    });

    it('rejects non-HTTP navigation before approval or connection acquisition', async () => {
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission,
            connect: harness.connect,
        });

        const execution = registration.execute(
            { action: 'navigate', url: 'file:///home/user/.ssh/id_rsa' },
            toolContext(),
        );

        await expect(execution).rejects.toThrow('must use http or https');
        expect(requestPermission).not.toHaveBeenCalled();
        expect(harness.connections).toHaveLength(0);
    });

    it('removes navigation credentials and query values from approvals and output', async () => {
        const harness = new BrowserHarness();
        const requests: PermissionRequest[] = [];
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: (request) => {
                requests.push(request);
                return allowPermission(request);
            },
            connect: harness.connect,
        });
        const secret = 'navigation-query-secret';

        const output = await registration.execute(
            { action: 'navigate', url: `https://user:password@example.test/path?token=${secret}#fragment` },
            toolContext(),
        );
        await registration.execute(
            { action: 'navigate', url: 'https://example.test/path?token=a-different-secret' },
            toolContext(),
        );

        expect(JSON.stringify(requests)).not.toContain(secret);
        expect(JSON.stringify(requests)).not.toContain('password');
        expect(output.url).not.toContain(secret);
        expect(output.url).not.toContain('password');
        expect(output.url).toContain('token=%5BREDACTED%5D');
        expect(requests[0]?.permission?.patterns).not.toEqual(requests[1]?.permission?.patterns);
    });

    it.each([
        'hangClose',
        'hangDisconnect',
    ] as const)('does not replace resources while timed-out cleanup remains unresolved: %s', async (hangingOperation) => {
        vi.useFakeTimers();
        const harness = new BrowserHarness({ extractionError: 'extract failed', [hangingOperation]: true });
        const registration = createRegistration(harness, { protocolTimeoutMs: 25 });

        const first = registration?.execute({ action: 'extract' }, toolContext());
        const firstResult = expect(first).rejects.toThrow('extraction failed');
        await vi.advanceTimersByTimeAsync(25);
        await firstResult;

        const second = registration?.execute({ action: 'extract', timeout: 1 }, toolContext());
        await Promise.resolve();
        expect(harness.connections).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await second)?.status).toBe('timed_out');
        expect(harness.connections).toHaveLength(1);
    });

    it.each([
        'closeError',
        'disconnectError',
    ] as const)('fails closed after cleanup rejects without replacing resources: %s', async (failingOperation) => {
        const harness = new BrowserHarness({
            extractionError: 'extract failed',
            [failingOperation]: 'cleanup rejected',
        });
        const registration = createRegistration(harness);

        await expect(registration?.execute({ action: 'extract' }, toolContext())).rejects.toThrow('extraction failed');
        await expect(registration?.execute({ action: 'extract' }, toolContext())).rejects.toThrow(
            'previous browser resource cleanup failed',
        );

        expect(harness.connections).toHaveLength(1);
    });
});

function allowPermission(request: { readonly id: string }) {
    return { requestId: request.id, status: 'allow' as const };
}

function secretToolError(secret: string, classification: 'credential' | 'secret'): ToolExecutionError {
    return new ToolExecutionError(
        {
            code: 'tool_failed',
            message: secret,
            retryable: false,
            redactions: [{ classification, reason: secret, replacement: secret }],
        },
        [{ type: 'log', timestamp: '2026-07-14T00:00:00.000Z', message: secret }],
    );
}

async function expectRedactedToolError(execution: unknown): Promise<void> {
    await expect(execution).rejects.toMatchObject({
        message: expect.stringContaining('[REDACTED_CREDENTIAL]'),
        error: {
            redactions: [
                expect.objectContaining({
                    reason: expect.stringContaining('[REDACTED_CREDENTIAL]'),
                    replacement: expect.stringContaining('[REDACTED_CREDENTIAL]'),
                }),
            ],
        },
        events: [expect.objectContaining({ message: expect.stringContaining('[REDACTED_CREDENTIAL]') })],
    });
}
