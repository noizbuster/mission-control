/**
 * `lsp` tool — bridge to a Language Server (LSP) for compiler-grade code intelligence
 * (Phase 4 deferred item): diagnostics, hover, go-to-definition. The agent calls `lsp` with
 * an `operation` + `uri` (+ line/character for positional ops) and the tool delegates to an
 * injected `LspClient`.
 *
 * The client seam (`diagnostics` / `hover` / `definition`) is where real transport lives — a
 * stdio JSON-RPC client that spawns + syncs an LSP server (tsserver, rust-analyzer, etc.).
 * The in-process `InProcessLspClient` (below) serves tests without a live server. The seam
 * keeps the tool contract testable; a real client implements document-open + sync separately.
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

/**
 * The LSP client seam. Real implementations spawn a language server over stdio JSON-RPC,
 * open/sync the document, then answer. The in-process client serves tests.
 */
export type LspClient = {
    diagnostics(uri: string): Promise<readonly LspDiagnostic[]>;
    hover(uri: string, line: number, character: number): Promise<LspHover | undefined>;
    definition(uri: string, line: number, character: number): Promise<readonly LspLocation[]>;
};

const lspInputSchema = z.discriminatedUnion('operation', [
    z.object({
        operation: z.literal('diagnostics'),
        uri: z.string().min(1),
    }),
    z.object({
        operation: z.literal('hover'),
        uri: z.string().min(1),
        line: z.number().int().nonnegative(),
        character: z.number().int().nonnegative(),
    }),
    z.object({
        operation: z.literal('definition'),
        uri: z.string().min(1),
        line: z.number().int().nonnegative(),
        character: z.number().int().nonnegative(),
    }),
]);
export type LspInput = z.infer<typeof lspInputSchema>;

const lspOutputSchema = z.object({
    operation: z.string(),
    uri: z.string(),
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
            'Query a Language Server for code intelligence: diagnostics for a file, or hover/definition at a position. ' +
            'Use for type errors, symbol docs, and go-to-definition backed by the real compiler.',
        capabilityClasses: ['read'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['diagnostics', 'hover', 'definition'] },
                uri: { type: 'string', description: 'File URI (e.g. file:///abs/path).' },
                line: { type: 'integer', minimum: 0, description: '0-based line (required for hover/definition).' },
                character: {
                    type: 'integer',
                    minimum: 0,
                    description: '0-based character (required for hover/definition).',
                },
            },
            required: ['operation', 'uri'],
            additionalProperties: false,
        },
        inputSchema: lspInputSchema,
        outputSchema: lspOutputSchema,
        outputLimit: { maxModelOutputChars: limit },
        ...(input.guideline !== undefined ? { guideline: input.guideline } : {}),
        execute: async (toolInput) => {
            try {
                let result: unknown;
                if (toolInput.operation === 'diagnostics') {
                    result = await input.client.diagnostics(toolInput.uri);
                } else {
                    result =
                        toolInput.operation === 'hover'
                            ? await input.client.hover(toolInput.uri, toolInput.line, toolInput.character)
                            : await input.client.definition(toolInput.uri, toolInput.line, toolInput.character);
                }
                return { operation: toolInput.operation, uri: toolInput.uri, result, truncated: false };
            } catch (error) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `lsp ${toolInput.operation} ${toolInput.uri} failed: ${error instanceof Error ? error.message : String(error)}`,
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

/** In-process LSP client for tests (no real language-server transport). */
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
