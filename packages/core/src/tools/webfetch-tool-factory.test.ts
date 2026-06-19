import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry.js';
import { registerWebfetchTool } from './webfetch-tool-factory.js';
import { createServer, type Server } from 'node:http';

describe('webfetch self-gating factory (graph-path permission gate)', () => {
    let fetchCalls: readonly string[];
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        fetchCalls = [];
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('calls requestPermission with kind network and surfaces approval_required when denied', async () => {
        const registry = await buildRegistry((request) => {
            capturedRequest = request;
            return { requestId: request.id, status: 'requires_approval', reason: 'no automatic network access' };
        });

        const settlement = await invokeWebfetch(registry, 'https://example.test/docs');

        expect(capturedRequest?.permission?.kind).toBe('network');
        expect(capturedRequest?.action).toBe('webfetch');
        expect(capturedRequest?.reason).toContain('https://example.test/docs');
        expect(capturedRequest?.permission?.patterns).toContain('https://example.test/docs');
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_required');
        expect(settlement.result.error?.message).toContain('no automatic network access');
        expect(fetchCalls).toHaveLength(0);
    });

    it('surfaces approval_denied when the decision is deny', async () => {
        const registry = await buildRegistry(() => ({
            requestId: 'permission_webfetch_call',
            status: 'deny' as const,
            reason: 'operator denied',
        }));

        const settlement = await invokeWebfetch(registry, 'https://denied.test');

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_denied');
        expect(fetchCalls).toHaveLength(0);
    });

    it('rejects a malformed url before requesting permission or fetching', async () => {
        const registry = await buildRegistry(() => ({
            requestId: 'permission_webfetch_call',
            status: 'allow' as const,
            reason: 'approved',
        }));

        const settlement = await invokeWebfetchRaw(registry, { url: 'not-a-valid-url' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.code).toBe('schema_invalid');
        expect(capturedRequest).toBeUndefined();
        expect(fetchCalls).toHaveLength(0);
    });

    describe('completes the fetch when approved (local fixture)', () => {
        let server: Server;
        let baseUrl: string;

        beforeEach(
            () =>
                new Promise<void>((resolve) => {
                    server = createServer((_req, res) => {
                        res.writeHead(200, { 'content-type': 'text/plain' });
                        res.end('webfetch fixture body');
                    });
                    server.listen(0, '127.0.0.1', () => {
                        const address = server.address();
                        const port = typeof address === 'object' && address !== null ? address.port : 0;
                        baseUrl = `http://127.0.0.1:${port}`;
                        resolve();
                    });
                }),
        );

        afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

        it('proceeds to fetch after an allow decision', async () => {
            const registry = await buildRegistry((request) => ({
                requestId: request.id,
                status: 'allow' as const,
                reason: 'approved',
            }));

            const settlement = await invokeWebfetch(registry, `${baseUrl}/`);

            expect(settlement.result.status).toBe('completed');
            expect(fetchCalls).toHaveLength(1);
            const output = settlement.structuredOutput as { body: string };
            expect(output.body).toContain('webfetch fixture body');
        });
    });

    let capturedRequest: PermissionRequest | undefined;

    async function buildRegistry(
        decide: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>,
    ): Promise<ToolRegistry> {
        capturedRequest = undefined;
        globalThis.fetch = ((input: string) => {
            fetchCalls = [...fetchCalls, input];
            return originalFetch(input);
        }) as typeof globalThis.fetch;
        const registry = new ToolRegistry();
        await registerWebfetchTool(registry, {
            workspaceRoot: '/workspace',
            requestPermission: (request) => {
                capturedRequest = request;
                return Promise.resolve(decide(request));
            },
        });
        return registry;
    }

    async function invokeWebfetch(registry: ToolRegistry, url: string) {
        return invokeWebfetchRaw(registry, { url });
    }

    async function invokeWebfetchRaw(registry: ToolRegistry, input: Readonly<Record<string, unknown>>) {
        const advertisement = registry.advertise().find((tool) => tool.name === 'webfetch');
        if (advertisement === undefined) {
            throw new TypeError('webfetch not registered');
        }
        return registry.invoke({
            toolCallId: 'webfetch_call',
            toolName: 'webfetch',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });
    }
});
