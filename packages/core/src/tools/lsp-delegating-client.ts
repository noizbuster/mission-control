/**
 * Delegating `LspClient` built on top of `LspServerManager`. Each operation
 * resolves the appropriate `StdioLspClient` for the file's language via
 * `getClientForFile`, then delegates.
 *
 * The three required operations (diagnostics, hover, definition) always produce
 * a result — empty diagnostics / empty definition list / undefined hover when no
 * server is available for the file's language. The five positional extended
 * operations (references, documentSymbol, implementation, typeDefinition,
 * callHierarchyIncoming) delegate via optional chaining: they return `[]` when
 * the resolved `StdioLspClient` has not implemented them yet (Task 15 only
 * shipped the required three; Task 18 can fill them in).
 *
 * `workspaceSymbol` is intentionally left undefined: without a file URI there is
 * no language to route by. The `lsp` tool reports a clear "does not support"
 * error for that operation instead of silently guessing a server.
 */
import type { LspServerManager } from './lsp-server-manager.js';
import type { LspCallHierarchyItem, LspClient, LspDiagnostic, LspHover, LspLocation, LspSymbol } from './lsp-tool.js';

export function createDelegatingLspClient(manager: LspServerManager): LspClient {
    return {
        async diagnostics(uri: string): Promise<readonly LspDiagnostic[]> {
            const client = await resolveClient(manager, uri);
            return client !== undefined ? client.diagnostics(uri) : [];
        },
        async hover(uri: string, line: number, character: number): Promise<LspHover | undefined> {
            const client = await resolveClient(manager, uri);
            if (client === undefined) return undefined;
            return client.hover(uri, line, character);
        },
        async definition(uri: string, line: number, character: number): Promise<readonly LspLocation[]> {
            const client = await resolveClient(manager, uri);
            return client !== undefined ? client.definition(uri, line, character) : [];
        },
        async references(uri: string, line: number, character: number): Promise<readonly LspLocation[]> {
            const client = await resolveClient(manager, uri);
            return client?.references?.(uri, line, character) ?? [];
        },
        async documentSymbol(uri: string): Promise<readonly LspSymbol[]> {
            const client = await resolveClient(manager, uri);
            return client?.documentSymbol?.(uri) ?? [];
        },
        async implementation(uri: string, line: number, character: number): Promise<readonly LspLocation[]> {
            const client = await resolveClient(manager, uri);
            return client?.implementation?.(uri, line, character) ?? [];
        },
        async typeDefinition(uri: string, line: number, character: number): Promise<readonly LspLocation[]> {
            const client = await resolveClient(manager, uri);
            return client?.typeDefinition?.(uri, line, character) ?? [];
        },
        async callHierarchyIncoming(
            uri: string,
            line: number,
            character: number,
        ): Promise<readonly LspCallHierarchyItem[]> {
            const client = await resolveClient(manager, uri);
            return client?.callHierarchyIncoming?.(uri, line, character) ?? [];
        },
    };
}

/**
 * Resolve the language client for a URI, widened to the `LspClient` seam so the
 * optional extended operations are visible. `StdioLspClient implements LspClient`
 * so this widening is type-safe without a cast.
 */
async function resolveClient(manager: LspServerManager, uri: string): Promise<LspClient | undefined> {
    return manager.getClientForFile(uriToPath(uri));
}

/** Strip a `file://` scheme prefix so the manager can extract the extension. */
function uriToPath(uri: string): string {
    if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.slice('file://'.length));
    }
    return uri;
}
