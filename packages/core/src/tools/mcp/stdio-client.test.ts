import { describe, expect, it } from 'vitest';
import { createMcpToolRegistration } from '../mcp-tool.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import { StdioMcpClient } from './stdio-client.js';

const fixturePath = new URL('./fixtures/stdio-fixture-server.mjs', import.meta.url).pathname;
const ctx = { toolCallId: 'c1', toolName: 'mcp', signal: new AbortController().signal };
const SPAWN_TIMEOUT = 15000;

function makeClient(options: {
    readonly mode?: string;
    readonly timeoutMs?: number;
    readonly secrets?: readonly string[];
}): StdioMcpClient {
    const mode = options.mode ?? 'normal';
    return new StdioMcpClient({
        command: process.execPath,
        args: [fixturePath, mode],
        cwd: process.cwd(),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
    });
}

describe('StdioMcpClient (loopback stdio fixture)', () => {
    it(
        'lists the fixture tools within the deadline',
        async () => {
            const client = makeClient({ timeoutMs: 4000 });
            try {
                await client.connect();
                const tools = await client.listTools();
                expect(tools.map((tool) => tool.name).sort()).toEqual(['echo', 'fail', 'greet']);
            } finally {
                await client.close();
            }
        },
        SPAWN_TIMEOUT,
    );

    it(
        'calls a tool and returns its result',
        async () => {
            const client = makeClient({ timeoutMs: 4000 });
            try {
                await client.connect();
                const result = await client.callTool({ name: 'greet', arguments: { name: 'world' } });
                expect(JSON.stringify(result)).toContain('hello world');
            } finally {
                await client.close();
            }
        },
        SPAWN_TIMEOUT,
    );

    it(
        'truncates tool output at the model-output limit via the mcp tool registration',
        async () => {
            const client = makeClient({ timeoutMs: 4000 });
            try {
                await client.connect();
                const tool = createMcpToolRegistration({ client, maxModelOutputChars: 64 });
                const longText = 'X'.repeat(500);
                const output = await tool.execute({ tool: 'echo', arguments: { text: longText } }, ctx);
                const modelOutput = tool.toModelOutput?.(output) ?? '';
                expect(modelOutput.length).toBeLessThan(longText.length);
                expect(modelOutput).toContain('truncated');
            } finally {
                await client.close();
            }
        },
        SPAWN_TIMEOUT,
    );

    it(
        'rejects with a retryable ToolExecutionError when the server crashes on startup',
        async () => {
            const client = makeClient({ mode: 'crash', timeoutMs: 4000 });
            let caught: unknown;
            try {
                await client.connect();
            } catch (error) {
                caught = error;
            } finally {
                await client.close();
            }
            expect(caught).toBeInstanceOf(ToolExecutionError);
            if (caught instanceof ToolExecutionError) {
                expect(caught.error.retryable).toBe(true);
            }
        },
        SPAWN_TIMEOUT,
    );

    it(
        'rejects at the deadline (not an infinite hang) when the server hangs on listTools',
        async () => {
            const deadlineMs = 1200;
            const client = makeClient({ mode: 'hung', timeoutMs: deadlineMs });
            const startedAt = Date.now();
            let caught: unknown;
            try {
                await client.connect();
                await client.listTools();
            } catch (error) {
                caught = error;
            } finally {
                await client.close();
            }
            const elapsed = Date.now() - startedAt;
            expect(caught).toBeInstanceOf(ToolExecutionError);
            if (caught instanceof ToolExecutionError) {
                expect(caught.error.retryable).toBe(true);
            }
            // PRIMARY adversarial proof: the call surfaces near the deadline, not after an infinite hang.
            expect(elapsed).toBeLessThan(deadlineMs + 4000);
            // The child is torn down: a follow-up call fails because the client is no longer connected.
            await expect(client.listTools()).rejects.toBeInstanceOf(ToolExecutionError);
        },
        SPAWN_TIMEOUT,
    );

    it(
        'redacts a configured secret from a settled callTool result',
        async () => {
            const secret = 'FIXTURE_SECRET_VALUE_42';
            const client = makeClient({ timeoutMs: 4000, secrets: [secret] });
            try {
                await client.connect();
                const result = await client.callTool({ name: 'echo', arguments: { text: secret } });
                const serialized = JSON.stringify(result);
                expect(serialized).not.toContain(secret);
                expect(serialized).toContain('[REDACTED]');
            } finally {
                await client.close();
            }
        },
        SPAWN_TIMEOUT,
    );

    it(
        'redacts a configured secret from a thrown ToolExecutionError message',
        async () => {
            const secret = 'FIXTURE_SECRET_VALUE_99';
            const client = makeClient({ timeoutMs: 4000, secrets: [secret] });
            let caught: unknown;
            try {
                await client.connect();
                try {
                    await client.callTool({ name: 'fail', arguments: { reason: secret } });
                } catch (error) {
                    caught = error;
                }
            } finally {
                await client.close();
            }
            expect(caught).toBeInstanceOf(ToolExecutionError);
            if (caught instanceof ToolExecutionError) {
                expect(caught.error.message).not.toContain(secret);
                expect(caught.error.message).toContain('[REDACTED]');
            }
        },
        SPAWN_TIMEOUT,
    );
});
