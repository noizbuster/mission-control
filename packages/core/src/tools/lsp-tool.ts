// allow: SIZE_OK — task 17 spec scopes changes to this single file (the lsp tool contract +
// its in-process test client, one cohesive module). Sibling lsp-stdio-client.ts and
// ast-grep-runner.ts set the precedent for a single cohesive tool module over the 250-line
// ceiling. Splitting would scatter the `LspClient` seam, the tool registration, and the
// `InProcessLspClient` test helper that the spec mandates stay together here.
/**
 * `lsp` tool — bridge to a Language Server (LSP) for compiler-grade code intelligence. Nine
 * operations: diagnostics, hover, definition, references, documentSymbol, workspaceSymbol,
 * implementation, typeDefinition, callHierarchyIncoming. The agent calls `lsp` with an
 * `operation` + `uri` (+ line/character for positional ops, or `query` for workspace symbol)
 * and the tool delegates to an injected `LspClient`.
 *
 * The client seam is where real transport lives — a stdio JSON-RPC client that spawns + syncs
 * an LSP server (tsserver, rust-analyzer, etc.). The first three operations
 * (`diagnostics` / `hover` / `definition`) are required on every client. The six extended
 * operations are optional on the seam: a client that has not implemented them yet leaves the
 * method `undefined`, and the tool reports a clear "does not support" error instead of
 * crashing. This keeps `StdioLspClient` (which currently implements only the required three)
 * type-checking without forcing a concurrent change; Task 18 can fill them in.
 *
 * The in-process `InProcessLspClient` (below) serves tests for the required three operations
 * without a live server. The seam keeps the tool contract testable; a real client implements
 * document-open + sync separately. LSP positions are 0-indexed (line + character start at 0).
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput, withContinuationHint } from './truncate.js';

export type LspDiagnostic = {
    readonly message: string;
    readonly severity: 'error' | 'warning' | 'information' | 'hint';
    readonly line: number;
    readonly character: number;
    readonly source?: string;
};

export type LspHover = {
    readonly contents: string;
};

export type LspLocation = {
    readonly uri: string;
    readonly line: number;
    readonly character: number;
};

export type LspPosition = {
    readonly line: number;
    readonly character: number;
};

export type LspRange = {
    readonly start: LspPosition;
    readonly end: LspPosition;
};

export type LspSymbol = {
    readonly name: string;
    readonly kind: string;
    readonly range: LspRange;
    readonly children?: readonly LspSymbol[];
};

export type LspCallHierarchyItem = {
    readonly name: string;
    readonly kind: string;
    readonly uri: string;
    readonly range: LspRange;
};

/**
 * The LSP client seam. Real implementations spawn a language server over stdio JSON-RPC,
 * open/sync the document, then answer. The in-process client serves tests.
 *
 * `diagnostics`, `hover`, and `definition` are required. The six extended operations are
 * optional: clients that do not implement them yet leave the method absent, and the tool
 * surfaces a clear "does not support operation" error for that operation.
 */
export type LspClient = {
    diagnostics(uri: string): Promise<readonly LspDiagnostic[]>;
    hover(uri: string, line: number, character: number): Promise<LspHover | undefined>;
    definition(uri: string, line: number, character: number): Promise<readonly LspLocation[]>;
    references?(uri: string, line: number, character: number): Promise<readonly LspLocation[]>;
    documentSymbol?(uri: string): Promise<readonly LspSymbol[]>;
    workspaceSymbol?(query: string): Promise<readonly LspSymbol[]>;
    implementation?(uri: string, line: number, character: number): Promise<readonly LspLocation[]>;
    typeDefinition?(uri: string, line: number, character: number): Promise<readonly LspLocation[]>;
    callHierarchyIncoming?(uri: string, line: number, character: number): Promise<readonly LspCallHierarchyItem[]>;
};

const POSITIONAL_FIELDS = {
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
} as const;

const lspInputSchema = z.discriminatedUnion('operation', [
    z.object({
        operation: z.literal('diagnostics'),
        uri: z.string().min(1),
    }),
    z.object({
        operation: z.literal('hover'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
    z.object({
        operation: z.literal('definition'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
    z.object({
        operation: z.literal('references'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
    z.object({
        operation: z.literal('documentSymbol'),
        uri: z.string().min(1),
    }),
    z.object({
        operation: z.literal('workspaceSymbol'),
        query: z.string().min(1),
    }),
    z.object({
        operation: z.literal('implementation'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
    z.object({
        operation: z.literal('typeDefinition'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
    z.object({
        operation: z.literal('callHierarchyIncoming'),
        uri: z.string().min(1),
        ...POSITIONAL_FIELDS,
    }),
]);
export type LspInput = z.infer<typeof lspInputSchema>;

const lspOutputSchema = z.object({
    operation: z.string(),
    // Absent for workspaceSymbol (a workspace-wide query has no single file target).
    uri: z.string().optional(),
    result: z.unknown(),
    truncated: z.boolean(),
});
export type LspOutput = z.infer<typeof lspOutputSchema>;

export type CreateLspToolInput = {
    readonly client: LspClient;
    readonly maxModelOutputChars?: number;
    /**
     * Self-describing usage hint surfaced in the system prompt. Must stay absent when unset so
     * the advertised version hash is stable (see ToolRegistrationMetadataSchema.guideline).
     */
    readonly guideline?: string;
};

const DEFAULT_LSP_OUTPUT_LIMIT = 8000;

export function createLspToolRegistration(input: CreateLspToolInput): ToolRegistration<LspInput, LspOutput> {
    const limit = input.maxModelOutputChars ?? DEFAULT_LSP_OUTPUT_LIMIT;
    return {
        name: 'lsp',
        description:
            'Query a Language Server for code intelligence: diagnostics, hover, definition, references, ' +
            'documentSymbol, workspaceSymbol, implementation, typeDefinition, and incoming call hierarchy. ' +
            'Use for type errors, symbol docs, go-to-definition, find-references, symbol outlines, and ' +
            'caller discovery backed by the real compiler.',
        capabilityClasses: ['read'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: [
                        'diagnostics',
                        'hover',
                        'definition',
                        'references',
                        'documentSymbol',
                        'workspaceSymbol',
                        'implementation',
                        'typeDefinition',
                        'callHierarchyIncoming',
                    ],
                },
                uri: {
                    type: 'string',
                    description:
                        'File URI (e.g. file:///abs/path). Required for every operation except workspaceSymbol.',
                },
                query: { type: 'string', description: 'Symbol query string (required for workspaceSymbol).' },
                line: {
                    type: 'integer',
                    minimum: 0,
                    description: '0-based line (required for positional operations).',
                },
                character: {
                    type: 'integer',
                    minimum: 0,
                    description: '0-based character (required for positional operations).',
                },
            },
            // Zod enforces per-operation required fields precisely; the JSON schema advertises
            // only `operation` as universally required since `uri`/`query`/positional fields vary.
            required: ['operation'],
            additionalProperties: false,
        },
        inputSchema: lspInputSchema,
        outputSchema: lspOutputSchema,
        outputLimit: { maxModelOutputChars: limit },
        ...(input.guideline !== undefined ? { guideline: input.guideline } : {}),
        execute: async (toolInput) => {
            try {
                const result = await dispatchLspOperation(input.client, toolInput);
                return buildLspOutput(toolInput, result);
            } catch (error) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `lsp ${toolInput.operation} ${describeTarget(toolInput)} failed: ${error instanceof Error ? error.message : String(error)}`,
                    retryable: true,
                });
            }
        },
        toModelOutput: (output) => {
            const text = typeof output.result === 'string' ? output.result : safeStringify(output.result);
            const truncated = truncateOutput(text, limit);
            return withContinuationHint(truncated, '');
        },
    };
}

/** Exhaustive dispatch over the `operation` discriminant. Optional methods are guarded. */
async function dispatchLspOperation(client: LspClient, input: LspInput): Promise<unknown> {
    switch (input.operation) {
        case 'diagnostics':
            return client.diagnostics(input.uri);
        case 'hover':
            return client.hover(input.uri, input.line, input.character);
        case 'definition':
            return client.definition(input.uri, input.line, input.character);
        case 'references':
            return requireClientMethod(client.references, 'references')(input.uri, input.line, input.character);
        case 'implementation':
            return requireClientMethod(client.implementation, 'implementation')(input.uri, input.line, input.character);
        case 'typeDefinition':
            return requireClientMethod(client.typeDefinition, 'typeDefinition')(input.uri, input.line, input.character);
        case 'callHierarchyIncoming':
            return requireClientMethod(client.callHierarchyIncoming, 'callHierarchyIncoming')(
                input.uri,
                input.line,
                input.character,
            );
        case 'documentSymbol':
            return requireClientMethod(client.documentSymbol, 'documentSymbol')(input.uri);
        case 'workspaceSymbol':
            return requireClientMethod(client.workspaceSymbol, 'workspaceSymbol')(input.query);
        default:
            return assertNeverLspInput(input);
    }
}

/** Narrows an optional client method; throws a descriptive error when the client lacks support. */
function requireClientMethod<T>(method: T | undefined, operation: string): T {
    if (method === undefined) {
        throw new Error(`language client does not support operation "${operation}"`);
    }
    return method;
}

/** Exhaustiveness guard: if a new operation joins `LspInput` without a case above, this errors. */
function assertNeverLspInput(value: never): never {
    throw new Error(`unhandled lsp operation: ${String(value)}`);
}

function buildLspOutput(input: LspInput, result: unknown): LspOutput {
    if (input.operation === 'workspaceSymbol') {
        return { operation: input.operation, result, truncated: false };
    }
    return { operation: input.operation, uri: input.uri, result, truncated: false };
}

function describeTarget(input: LspInput): string {
    return input.operation === 'workspaceSymbol' ? input.query : input.uri;
}

/** In-process LSP client for tests (no real language-server transport). Implements the
 *  required three operations; extended operations stay absent so unsupported-path behavior
 *  can be exercised against the same class. */
export class InProcessLspClient implements LspClient {
    private readonly diagnosticsByUri: ReadonlyMap<string, readonly LspDiagnostic[]>;
    private readonly hoverFn?: (uri: string, line: number, character: number) => LspHover | undefined;
    private readonly definitionFn?: (uri: string, line: number, character: number) => readonly LspLocation[];

    constructor(input: {
        readonly diagnostics?: ReadonlyArray<{ readonly uri: string; readonly items: readonly LspDiagnostic[] }>;
        readonly hover?: (uri: string, line: number, character: number) => LspHover | undefined;
        readonly definition?: (uri: string, line: number, character: number) => readonly LspLocation[];
    }) {
        this.diagnosticsByUri = new Map((input.diagnostics ?? []).map((entry) => [entry.uri, entry.items]));
        if (input.hover !== undefined) {
            this.hoverFn = input.hover;
        }
        if (input.definition !== undefined) {
            this.definitionFn = input.definition;
        }
    }

    async diagnostics(uri: string): Promise<readonly LspDiagnostic[]> {
        return this.diagnosticsByUri.get(uri) ?? [];
    }

    async hover(uri: string, line: number, character: number): Promise<LspHover | undefined> {
        return this.hoverFn?.(uri, line, character);
    }

    async definition(uri: string, line: number, character: number): Promise<readonly LspLocation[]> {
        return this.definitionFn?.(uri, line, character) ?? [];
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
