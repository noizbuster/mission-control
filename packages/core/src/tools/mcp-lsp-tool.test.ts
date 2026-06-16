import { describe, expect, it } from 'vitest';
import {
    createLspToolRegistration,
    InProcessLspClient,
    type LspDiagnostic,
} from './lsp-tool.js';
import { createMcpToolRegistration, InProcessMcpClient } from './mcp-tool.js';

const ctx = { toolCallId: 'c1', toolName: 'mcp', signal: new AbortController().signal };
const lspCtx = { toolCallId: 'c1', toolName: 'lsp', signal: new AbortController().signal };

describe('mcp tool (seam + in-process client)', () => {
    it('delegates a call to the MCP client and returns its result', async () => {
        const client = new InProcessMcpClient([
            { name: 'query_db', description: 'query the db', call: (args) => ({ rows: (args as { q?: string } | undefined)?.q ?? 'none' }) },
        ]);
        const tool = createMcpToolRegistration({ client });
        const out = await tool.execute({ tool: 'query_db', arguments: { q: 'SELECT 1' } }, ctx);
        expect(out.result).toEqual({ rows: 'SELECT 1' });
        expect(out.truncated).toBe(false);
    });

    it('lists the server tools', async () => {
        const client = new InProcessMcpClient([{ name: 'a', call: () => 1 }, { name: 'b', description: 'bee', call: () => 2 }]);
        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    });

    it('throws a ToolExecutionError for an unknown server tool', async () => {
        const client = new InProcessMcpClient([{ name: 'a', call: () => 1 }]);
        const tool = createMcpToolRegistration({ client });
        await expect(tool.execute({ tool: 'missing' }, ctx)).rejects.toThrow(/no tool named "missing"/);
    });

    it('wraps a throwing client call in a ToolExecutionError', async () => {
        const client = new InProcessMcpClient([
            {
                name: 'boom',
                call: () => {
                    throw new Error('server 500');
                },
            },
        ]);
        const tool = createMcpToolRegistration({ client });
        await expect(tool.execute({ tool: 'boom' }, ctx)).rejects.toThrow(/server 500/);
    });
});

describe('lsp tool (seam + in-process client)', () => {
    const diagnostics: ReadonlyArray<{ uri: string; items: readonly LspDiagnostic[] }> = [
        {
            uri: 'file:///a.ts',
            items: [
                { message: 'Type mismatch', severity: 'error', line: 3, character: 5, source: 'tsserver' },
                { message: 'Unused var', severity: 'warning', line: 7, character: 0 },
            ],
        },
    ];

    it('returns diagnostics for a file', async () => {
        const client = new InProcessLspClient({ diagnostics });
        const tool = createLspToolRegistration({ client });
        const out = await tool.execute({ operation: 'diagnostics', uri: 'file:///a.ts' }, lspCtx);
        expect(out.result).toEqual(diagnostics[0]?.items);
    });

    it('returns hover at a position', async () => {
        const client = new InProcessLspClient({
            hover: (_uri, line) => ({ contents: `symbol at line ${line}` }),
        });
        const tool = createLspToolRegistration({ client });
        const out = await tool.execute({ operation: 'hover', uri: 'file:///a.ts', line: 3, character: 5 }, lspCtx);
        expect(out.result).toEqual({ contents: 'symbol at line 3' });
    });

    it('returns definition locations at a position', async () => {
        const client = new InProcessLspClient({
            definition: () => [{ uri: 'file:///b.ts', line: 10, character: 2 }],
        });
        const tool = createLspToolRegistration({ client });
        const out = await tool.execute({ operation: 'definition', uri: 'file:///a.ts', line: 3, character: 5 }, lspCtx);
        expect(out.result).toEqual([{ uri: 'file:///b.ts', line: 10, character: 2 }]);
    });

    it('rejects hover/definition missing line + character at the schema layer', async () => {
        const client = new InProcessLspClient({});
        const tool = createLspToolRegistration({ client });
        expect(() => tool.inputSchema.parse({ operation: 'hover', uri: 'file:///a.ts' })).toThrow();
    });
});
