/**
 * Extended-operation tests for the `lsp` tool (Task 17 + Task 13 LSP 8-ops wiring).
 *
 * Covers all 8 canonical lsp_* operations against mock clients:
 *   lsp_status, lsp_diagnostics, lsp_goto_definition, lsp_find_references,
 *   lsp_symbols, lsp_prepare_rename, lsp_rename (effectful), lsp_install_decision.
 *
 * Also covers: diagnostics-ledger stale-drop, rename diff events + approval gating,
 * adversarial cases (malformed position, missing server → install_decision).
 */

import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { LspDiagnosticsLedger } from './lsp-diagnostics-ledger';
import { createLspRenameToolRegistration } from './lsp-rename-tool';
import {
    createLspToolRegistration,
    InProcessLspClient,
    type LspCallHierarchyItem,
    type LspClient,
    type LspDiagnostic,
    type LspHover,
    type LspLocation,
    type LspPrepareRenameResult,
    type LspServerStatusEntry,
    type LspSymbol,
    type LspWorkspaceEdit,
} from './lsp-tool';

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

// ---------------------------------------------------------------------------
// Task 13: 8 canonical lsp_* operations
// ---------------------------------------------------------------------------

const samplePrepareRename: LspPrepareRenameResult = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    placeholder: 'foo',
};

const sampleWorkspaceEdit: LspWorkspaceEdit = {
    changes: {
        [SAMPLE_URI]: [
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                newText: 'bar',
            },
        ],
    },
};

const sampleStatusEntries: readonly LspServerStatusEntry[] = [
    { languageId: 'typescript', command: 'typescript-language-server', available: true, active: true },
    { languageId: 'rust', command: 'rust-analyzer', available: false, active: false },
];

function fullClientWithRename(): LspClient {
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
        prepareRename: async () => samplePrepareRename,
        rename: async () => sampleWorkspaceEdit,
    };
}

describe('lsp tool — 8 canonical operations (Task 13)', () => {
    it('lsp_status returns server status entries', async () => {
        const tool = createLspToolRegistration({
            client: fullClient(),
            serverStatusProvider: () => sampleStatusEntries,
        });
        const out = await tool.execute({ operation: 'status' }, ctx);
        expect(out.result).toEqual(sampleStatusEntries);
        expect('uri' in out).toBe(false);
    });

    it('lsp_status returns empty when no provider is configured', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'status' }, ctx);
        expect(out.result).toEqual([]);
    });

    it('lsp_prepare_rename returns the rename range and placeholder', async () => {
        const tool = createLspToolRegistration({ client: fullClientWithRename() });
        const out = await tool.execute({ operation: 'prepareRename', uri: SAMPLE_URI, line: 0, character: 1 }, ctx);
        expect(out.result).toEqual(samplePrepareRename);
        expect(out.uri).toBe(SAMPLE_URI);
    });

    it('lsp_prepare_rename throws when the client does not support it', async () => {
        const tool = createLspToolRegistration({ client: new InProcessLspClient({}) });
        await expect(
            tool.execute({ operation: 'prepareRename', uri: SAMPLE_URI, line: 0, character: 0 }, ctx),
        ).rejects.toThrow(/does not support operation "prepareRename"/);
    });

    it('lsp_install_decision records the decision via the recorder', async () => {
        const recorder = vi.fn<(serverId: string, decision: 'declined' | 'allowed') => void>();
        const tool = createLspToolRegistration({
            client: fullClient(),
            installDecisionRecorder: recorder,
        });
        const out = await tool.execute({ operation: 'installDecision', serverId: 'rust', decision: 'declined' }, ctx);
        expect(recorder).toHaveBeenCalledWith('rust', 'declined');
        expect(out.result).toEqual({ serverId: 'rust', decision: 'declined', recorded: true });
    });

    it('lsp_install_decision reports recorded=false when no recorder is configured', async () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        const out = await tool.execute({ operation: 'installDecision', serverId: 'go', decision: 'allowed' }, ctx);
        expect(out.result).toEqual({ serverId: 'go', decision: 'allowed', recorded: false });
    });

    it('lsp_diagnostics reduces stale diagnostics via the ledger', async () => {
        const ledger = new LspDiagnosticsLedger();
        const tool = createLspToolRegistration({
            client: fullClient(),
            diagnosticsLedger: ledger,
        });
        const first = await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        expect(first.result).toEqual(sampleDiagnostics);

        const second = await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        expect(second.result).toEqual([]);
    });

    it('lsp_diagnostics surfaces new diagnostics after a ledger forget', async () => {
        const ledger = new LspDiagnosticsLedger();
        const tool = createLspToolRegistration({
            client: fullClient(),
            diagnosticsLedger: ledger,
        });
        await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        ledger.forget(SAMPLE_URI);
        const out = await tool.execute({ operation: 'diagnostics', uri: SAMPLE_URI }, ctx);
        expect(out.result).toEqual(sampleDiagnostics);
    });
});

// ---------------------------------------------------------------------------
// Diagnostics-ledger unit tests (stale-drop from oh-my-pi)
// ---------------------------------------------------------------------------

describe('LspDiagnosticsLedger — stale-drop', () => {
    it('surfaces all diagnostics on first call', () => {
        const ledger = new LspDiagnosticsLedger();
        const diags: readonly LspDiagnostic[] = [
            { message: 'error A', severity: 'error', line: 1, character: 0 },
            { message: 'error B', severity: 'warning', line: 2, character: 0 },
        ];
        expect(ledger.reduce(SAMPLE_URI, diags)).toEqual(diags);
    });

    it('drops diagnostics that were already surfaced', () => {
        const ledger = new LspDiagnosticsLedger();
        const diags: readonly LspDiagnostic[] = [{ message: 'error A', severity: 'error', line: 1, character: 0 }];
        ledger.reduce(SAMPLE_URI, diags);
        expect(ledger.reduce(SAMPLE_URI, diags)).toEqual([]);
    });

    it('surfaces only genuinely new diagnostics', () => {
        const ledger = new LspDiagnosticsLedger();
        const first: readonly LspDiagnostic[] = [{ message: 'error A', severity: 'error', line: 1, character: 0 }];
        ledger.reduce(SAMPLE_URI, first);
        const second: readonly LspDiagnostic[] = [
            { message: 'error A', severity: 'error', line: 5, character: 3 },
            { message: 'error B', severity: 'warning', line: 2, character: 0 },
        ];
        const fresh = ledger.reduce(SAMPLE_URI, second);
        expect(fresh).toHaveLength(1);
        expect(fresh[0]?.message).toBe('error B');
    });

    it('clears the baseline when diagnostics become empty', () => {
        const ledger = new LspDiagnosticsLedger();
        ledger.reduce(SAMPLE_URI, [{ message: 'error A', severity: 'error', line: 1, character: 0 }]);
        ledger.reduce(SAMPLE_URI, []);
        const refetched = ledger.reduce(SAMPLE_URI, [{ message: 'error A', severity: 'error', line: 1, character: 0 }]);
        expect(refetched).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// lsp_rename — effectful tool: diff events + approval
// ---------------------------------------------------------------------------

function allowAll(): (req: PermissionRequest) => PermissionDecision {
    return (req) => ({ requestId: req.id, status: 'allow' });
}

function denyAll(): (req: PermissionRequest) => PermissionDecision {
    return (req) => ({ requestId: req.id, status: 'deny', reason: 'test deny' });
}

const RENAME_CTX = { toolCallId: 'rename-1', toolName: 'lsp_rename', signal: new AbortController().signal };
const WORKSPACE_ROOT = '/workspace';

describe('lsp_rename — effectful tool', () => {
    it('applies the workspace edit and emits diff events after approval', async () => {
        const requestPermission = vi.fn(allowAll());
        const written = new Map<string, string>();
        const tool = createLspRenameToolRegistration({
            client: fullClientWithRename(),
            workspaceRoot: WORKSPACE_ROOT,
            requestPermission,
            applyDeps: {
                readDocument: async () => 'foo is here\n',
                writeDocument: async (uri, content) => {
                    written.set(uri, content);
                },
            },
        });

        const output = await tool.execute({ uri: SAMPLE_URI, line: 0, character: 0, newName: 'bar' }, RENAME_CTX);

        expect(output.status).toBe('applied');
        expect(output.fileCount).toBe(1);
        expect(output.diffFiles).toHaveLength(1);
        expect(written.get(SAMPLE_URI)).toBe('bar is here\n');
        expect(requestPermission).toHaveBeenCalledTimes(1);
        const events = tool.toEvents?.(output, RENAME_CTX) ?? [];
        expect(events).toHaveLength(2);
        expect(events[0]?.type).toBe('file.diff.proposed');
        expect(events[1]?.type).toBe('file.diff.applied');
    });

    it('throws approval_denied when permission is denied (no edit applied)', async () => {
        const requestPermission = vi.fn(denyAll());
        const writeDocument = vi.fn(async () => {});
        const tool = createLspRenameToolRegistration({
            client: fullClientWithRename(),
            workspaceRoot: WORKSPACE_ROOT,
            requestPermission,
            applyDeps: {
                readDocument: async () => 'foo\n',
                writeDocument,
            },
        });

        await expect(
            tool.execute({ uri: SAMPLE_URI, line: 0, character: 0, newName: 'bar' }, RENAME_CTX),
        ).rejects.toThrow(/lsp_rename: test deny/);
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(writeDocument).not.toHaveBeenCalled();
    });

    it('reports not_renameable when prepareRename returns undefined', async () => {
        const client: LspClient = {
            ...fullClientWithRename(),
            prepareRename: async () => undefined,
        };
        const tool = createLspRenameToolRegistration({
            client,
            workspaceRoot: WORKSPACE_ROOT,
            requestPermission: allowAll(),
        });
        const output = await tool.execute({ uri: SAMPLE_URI, line: 99, character: 99, newName: 'bar' }, RENAME_CTX);
        expect(output.status).toBe('not_renameable');
        expect(output.diffFiles).toEqual([]);
    });

    it('reports no_edit when rename returns an empty workspace edit', async () => {
        const client: LspClient = {
            ...fullClientWithRename(),
            rename: async () => ({ changes: {} }),
        };
        const tool = createLspRenameToolRegistration({
            client,
            workspaceRoot: WORKSPACE_ROOT,
            requestPermission: allowAll(),
        });
        const output = await tool.execute({ uri: SAMPLE_URI, line: 0, character: 0, newName: 'bar' }, RENAME_CTX);
        expect(output.status).toBe('no_edit');
        expect(output.diffFiles).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Adversarial: missing server → graceful, malformed position → empty result
// ---------------------------------------------------------------------------

describe('lsp tool — adversarial cases', () => {
    it('definition at an invalid position returns empty result, no crash', async () => {
        const client: LspClient = {
            ...fullClient(),
            definition: async () => [],
        };
        const tool = createLspToolRegistration({ client });
        const out = await tool.execute({ operation: 'definition', uri: SAMPLE_URI, line: 9999, character: 9999 }, ctx);
        expect(out.result).toEqual([]);
    });

    it('prepareRename at an invalid position returns not_renameable', async () => {
        const client: LspClient = {
            ...fullClientWithRename(),
            prepareRename: async () => undefined,
        };
        const tool = createLspRenameToolRegistration({
            client,
            workspaceRoot: WORKSPACE_ROOT,
            requestPermission: allowAll(),
        });
        const output = await tool.execute({ uri: SAMPLE_URI, line: 9999, character: 9999, newName: 'bar' }, RENAME_CTX);
        expect(output.status).toBe('not_renameable');
    });

    it('install_decision with an invalid decision value is rejected by the schema', () => {
        const tool = createLspToolRegistration({ client: fullClient() });
        expect(() =>
            tool.inputSchema.parse({ operation: 'installDecision', serverId: 'rust', decision: 'maybe' }),
        ).toThrow();
    });
});
