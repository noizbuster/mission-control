import {
    createDelegatingLspClient,
    createLspRenameToolRegistration,
    createLspToolRegistration,
    type LspClient,
    LspServerManager,
    type LspServerManagerDeps,
    type ToolRegistry,
} from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';

const LSP_GUIDELINE =
    'Use lsp for compiler-grade diagnostics, hover, go-to-definition, references, ' +
    'symbol outlines, implementation, type definition, and incoming call hierarchy ' +
    'instead of guessing types from source text.';

type AvailableLspToolOptions = {
    readonly registry: ToolRegistry;
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly lspClient?: LspClient;
    readonly deps?: LspServerManagerDeps;
};

export async function registerAvailableLspTool(options: AvailableLspToolOptions): Promise<void> {
    let client = options.lspClient;
    if (client === undefined) {
        const lspManager = new LspServerManager({ workspaceRoot: options.workspaceRoot }, options.deps);
        if ((await lspManager.detectAvailableServers()).length === 0) return;
        client = createDelegatingLspClient(lspManager);
    }
    options.registry.register(createLspToolRegistration({ client, guideline: LSP_GUIDELINE }));
    options.registry.register(
        createLspRenameToolRegistration({
            client,
            workspaceRoot: options.workspaceRoot,
            requestPermission: options.requestPermission,
        }),
    );
}
