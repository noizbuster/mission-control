/**
 * Extended-operation tests for the `lsp` tool (Task 17). Covers all 9 operations against a
 * full client, the 6 unsupported-operation paths against the minimal `InProcessLspClient`
 * (which implements only the required three), and per-operation schema validation.
 *
 * No `expect.stringMatching` matchers are used for structural checks; all assertions use concrete shapes or message regexes.
 */
import { describe, expect, it } from 'vitest';
import {
    createLspToolRegistration,
    InProcessLspClient,
    type LspCallHierarchyItem,
    type LspClient,
    type LspDiagnostic,
    type LspHover,
    type LspLocation,
    type LspSymbol,
} from './lsp-tool.js';

const ctx = { toolCallId: 'c1', toolName: 'lsp', signal: new AbortController().signal };
const SAMPLE_URI = 'file:///workspace/src/sample.ts';
const OTHER_URI = 'file:///workspace/src/other.ts';

const sampleDiagnostics: readonly LspDiagnostic[] = [
    { message: 'Type mismatch', severity: 'error', line: 3, character: 5, source: 'tsserver' },
];
const sampleHover: LspHover = { contents: '(x: number) => void' };
const sampleLocations: readonly LspLocation[] = [{ uri: OTHER_URI, line: 10, character: 2 }];
const sampleDocumentSymbols: readonly LspSymbol[] = [
    {
        name: 'foo',
        kind: 'Function',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        children: [
            {
                name: 'inner',
                kind: 'Variable',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
        ],
    },
];
const sampleWorkspaceSymbols: readonly LspSymbol[] = [
    {
        name: 'MyClass',
        kind: 'Class',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
    },
];
const sampleCallHierarchy: readonly LspCallHierarchyItem[] = [
    {
        name: 'caller',
        kind: 'Function',
        uri: OTHER_URI,
        range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } },
    },
];

/** A full `LspClient` that implements all 9 operations. */
function fullClient(): LspClient {
    return {
        diagnostics: async () => sampleDiagnostics,
        hover: async () => sampleHover,
        definition: async () => sampleLocations,
        references: async () => sampleLocations,
        documentSymbol: async () => sampleDocumentSymbols,
        workspaceSymbol: async () => sampleWorkspaceSymbols,
        implementation: async () => sampleLocations,
        typeDefinition: async () => sampleLocations,
        callHierarchyIncoming: async () => sampleCallHierarchy,
    };
}

describe('lsp tool — all 9 operations against a full client', () => {
    it('runs diagnostics and echoes the uri', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        expect(out).toEqual({
            operation: 'diagnostics',
            uri: SAMPLE_URI,
            result: sampleDiagnostics,
            truncated: false,
        });
    });

    it('runs hover at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'hover', uri: SAMPLE_URI, line: 3, character: 5 }, ctx);
        expect(out.result).toEqual(sampleHover);
        expect(out.uri).toBe(SAMPLE_URI);
        expect(out.operation).toBe('hover');
    });

    it('runs definition at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'definition', uri: SAMPLE_URI, line: 1, character: 0 }, ctx);
        expect(out.result).toEqual(sampleLocations);
    });

    it('runs references at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'references', uri: SAMPLE_URI, line: 1, character: 0 }, ctx);
        expect(out.result).toEqual(sampleLocations);
        expect(out.uri).toBe(SAMPLE_URI);
    });

    it('runs documentSymbol for a file', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'documentSymbol', uri: SAMPLE_URI }, ctx);
        expect(out.result).toEqual(sampleDocumentSymbols);
    });

    it('runs workspaceSymbol and omits uri from the output', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'workspaceSymbol', query: 'MyClass' }, ctx);
        expect(out.result).toEqual(sampleWorkspaceSymbols);
        expect(out.operation).toBe('workspaceSymbol');
        expect('uri' in out).toBe(false);
    });

    it('runs implementation at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'implementation', uri: SAMPLE_URI, line: 1, character: 0 }, ctx);
        expect(out.result).toEqual(sampleLocations);
    });

    it('runs typeDefinition at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'typeDefinition', uri: SAMPLE_URI, line: 1, character: 0 }, ctx);
        expect(out.result).toEqual(sampleLocations);
    });

    it('runs callHierarchyIncoming at a position', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute(
            { operation: 'callHierarchyIncoming', uri: SAMPLE_URI, line: 1, character: 0 },
            ctx,
        );
        expect(out.result).toEqual(sampleCallHierarchy);
    });
});

describe('lsp tool — extended operations on a 3-operation client', () => {
    // InProcessLspClient implements only the required three; the six extended methods are absent.
    const minimalClient: LspClient = new InProcessLspClient({});

    it('still supports the required diagnostics operation', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        const out = await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        expect(out.result).toEqual([]);
    });

    it('throws for references when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(
            tool.execute({ operation: 'references', uri: SAMPLE_URI, line: 0, character: 0 }, ctx),
        ).rejects.toThrow(/does not support operation "references"/);
    });

    it('throws for documentSymbol when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(tool.execute({ operation: 'documentSymbol', uri: SAMPLE_URI }, ctx)).rejects.toThrow(
            /does not support operation "documentSymbol"/,
        );
    });

    it('throws for workspaceSymbol when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(tool.execute({ operation: 'workspaceSymbol', query: 'foo' }, ctx)).rejects.toThrow(
            /does not support operation "workspaceSymbol"/,
        );
    });

    it('throws for implementation when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(
            tool.execute({ operation: 'implementation', uri: SAMPLE_URI, line: 0, character: 0 }, ctx),
        ).rejects.toThrow(/does not support operation "implementation"/);
    });

    it('throws for typeDefinition when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(
            tool.execute({ operation: 'typeDefinition', uri: SAMPLE_URI, line: 0, character: 0 }, ctx),
        ).rejects.toThrow(/does not support operation "typeDefinition"/);
    });

    it('throws for callHierarchyIncoming when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: minimalClient });
        await expect(
            tool.execute({ operation: 'callHierarchyIncoming', uri: SAMPLE_URI, line: 0, character: 0 }, ctx),
        ).rejects.toThrow(/does not support operation "callHierarchyIncoming"/);
    });
});

describe('lsp tool — schema validation for extended operations', () => {
    const tool = createLspToolRegistration({ client: fullClient() });

    it('rejects workspaceSymbol without a query', () => {
        expect(() => tool.inputSchema.parse({ operation: 'workspaceSymbol' })).toThrow();
    });

    it('rejects references without line/character', () => {
        expect(() => tool.inputSchema.parse({ operation: 'references', uri: SAMPLE_URI })).toThrow();
    });

    it('rejects documentSymbol without a uri', () => {
        expect(() => tool.inputSchema.parse({ operation: 'documentSymbol' })).toThrow();
    });

    it('rejects an unknown operation', () => {
        expect(() => tool.inputSchema.parse({ operation: 'nope', uri: SAMPLE_URI })).toThrow();
    });

    it('rejects a negative line for a positional operation', () => {
        expect(() =>
            tool.inputSchema.parse({ operation: 'implementation', uri: SAMPLE_URI, line: -1, character: 0 }),
        ).toThrow();
    });

    it('accepts each of the 9 operation shapes', () => {
        expect(() => tool.inputSchema.parse({ operation: 'diagnostics', uri: SAMPLE_URI })).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({ operation: 'hover', uri: SAMPLE_URI, line: 0, character: 0 }),
        ).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({ operation: 'definition', uri: SAMPLE_URI, line: 0, character: 0 }),
        ).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({ operation: 'references', uri: SAMPLE_URI, line: 0, character: 0 }),
        ).not.toThrow();
        expect(() => tool.inputSchema.parse({ operation: 'documentSymbol', uri: SAMPLE_URI })).not.toThrow();
        expect(() => tool.inputSchema.parse({ operation: 'workspaceSymbol', query: 'x' })).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({ operation: 'implementation', uri: SAMPLE_URI, line: 0, character: 0 }),
        ).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({ operation: 'typeDefinition', uri: SAMPLE_URI, line: 0, character: 0 }),
        ).not.toThrow();
        expect(() =>
            tool.inputSchema.parse({
                operation: 'callHierarchyIncoming',
                uri: SAMPLE_URI,
                line: 0,
                character: 0,
            }),
        ).not.toThrow();
    });
});
