import {
    createDelegatingLspClient,
    createLspToolRegistration,
    type LspClient,
    LspServerManager,
    type LspServerManagerDeps,
    type ToolRegistry,
} from '@mission-control/core';

const LSP_GUIDELINE =
    'Use lsp for compiler-grade diagnostics, hover, go-to-definition, references, ' +
    'symbol outlines, implementation, type definition, and incoming call hierarchy ' +
    'instead of guessing types from source text.';

export async function registerAvailableLspTool(
    registry: ToolRegistry,
    workspaceRoot: string,
    lspClient: LspClient | undefined,
    deps: LspServerManagerDeps | undefined,
): Promise<void> {
    if (lspClient !== undefined) {
        registry.register(createLspToolRegistration({ client: lspClient, guideline: LSP_GUIDELINE }));
        return;
    }
    const lspManager = new LspServerManager({ workspaceRoot }, deps);
    if ((await lspManager.detectAvailableServers()).length === 0) return;
    registry.register(
        createLspToolRegistration({ client: createDelegatingLspClient(lspManager), guideline: LSP_GUIDELINE }),
    );
}
