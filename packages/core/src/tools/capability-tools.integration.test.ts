/**
 * Phase 4 capability-tools acceptance: glob resolves real fixture paths, todowrite echoes a
 * structured list, webfetch returns a body from a local HTTP fixture — all through the real
 * ToolRegistry invoke path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globToolRegistration } from './glob-tool.js';
import { todoWriteToolRegistration } from './todowrite-tool.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement } from './tool-registry-types.js';
import { webfetchToolRegistration } from './webfetch-tool.js';
import { createServer, type Server } from 'node:http';

function registerAll(registry: ToolRegistry): readonly ToolAdvertisement[] {
    return [
        registry.register(globToolRegistration),
        registry.register(todoWriteToolRegistration),
        registry.register(webfetchToolRegistration),
    ];
}

describe('capability tools (glob / todowrite / webfetch)', () => {
    it('registers all three through the ToolRegistry', () => {
        const registry = new ToolRegistry();
        const ads = registerAll(registry);
        expect(ads.map((ad) => ad.name).sort()).toEqual(['glob', 'todowrite', 'webfetch']);
    });

    it('glob resolves ≥1 path for **/*.json under examples/abg', async () => {
        const registry = new ToolRegistry();
        const ad = registry.register(globToolRegistration);
        const settlement = await registry.invoke({
            toolCallId: 'c-glob',
            toolName: 'glob',
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({ pattern: '**/*.json', path: 'examples/abg', maxResults: 10 }),
        });
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as { paths: readonly string[] };
        expect(output.paths.length).toBeGreaterThan(0);
        expect(output.paths.some((path) => path.endsWith('.json'))).toBe(true);
    });

    it('todowrite echoes a validated structured list', async () => {
        const registry = new ToolRegistry();
        const ad = registry.register(todoWriteToolRegistration);
        const settlement = await registry.invoke({
            toolCallId: 'c-todo',
            toolName: 'todowrite',
            advertisedVersion: ad.version,
            argumentsJson: JSON.stringify({
                todos: [
                    { content: 'read files', status: 'completed' },
                    { content: 'edit code', status: 'in_progress' },
                ],
            }),
        });
        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as { todos: readonly { content: string; status: string }[] };
        expect(output.todos).toHaveLength(2);
        expect(settlement.modelOutput?.content).toContain('[~] edit code');
    });

    describe('webfetch against a local HTTP fixture', () => {
        let server: Server;
        let baseUrl: string;

        beforeEach(
            () =>
                new Promise<void>((resolve) => {
                    server = createServer((_req, res) => {
                        res.writeHead(200, { 'content-type': 'text/plain' });
                        res.end('hello webfetch fixture');
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

        it('returns the body bytes for a 2xx response', async () => {
            const registry = new ToolRegistry();
            const ad = registry.register(webfetchToolRegistration);
            const settlement = await registry.invoke({
                toolCallId: 'c-web',
                toolName: 'webfetch',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ url: `${baseUrl}/` }),
            });
            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as { status: number; body: string };
            expect(output.status).toBe(200);
            expect(output.body).toContain('hello webfetch fixture');
        });
    });
});
