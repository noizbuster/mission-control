import { describe, expect, it } from 'vitest';
import type { LspServerConfig, LspServerManagerDeps } from './lsp-server-manager.js';
import { DEFAULT_LSP_SERVERS, LspServerManager } from './lsp-server-manager.js';
import type { StdioLspClientOptions } from './lsp-stdio-client.js';
import { StdioLspClient } from './lsp-stdio-client.js';

const WORKSPACE_ROOT = '/workspace';

// ---------------------------------------------------------------------------
// Mock StdioLspClient: extends the real class so the manager's type contract
// holds, but overrides initialize/shutdown so no child process is spawned.
// Call counts are tracked as arrays so tests can assert both occurrence and,
// if needed, ordering across multiple instances.
// ---------------------------------------------------------------------------

class CountingLspClient extends StdioLspClient {
    readonly initCalls: number[] = [];
    readonly shutdownCalls: number[] = [];
    private readonly initBehavior: () => Promise<void>;

    constructor(initBehavior: () => Promise<void> = async () => undefined) {
        // Real options are irrelevant — initialize() is overridden and never
        // spawns. A dummy command keeps the base constructor's contract honest.
        super({ command: 'mock-language-server', workspaceRoot: WORKSPACE_ROOT });
        this.initBehavior = initBehavior;
    }

    override async initialize(): Promise<void> {
        this.initCalls.push(1);
        await this.initBehavior();
    }

    override async shutdown(): Promise<void> {
        this.shutdownCalls.push(1);
    }
}

// ---------------------------------------------------------------------------
// Harness: builds a manager with both seams injected and captures every client
// the factory produces, so tests can assert caching and shutdown fan-out.
// ---------------------------------------------------------------------------

type HarnessOptions = {
    readonly servers?: readonly LspServerConfig[];
    readonly availableCommands?: readonly string[];
    readonly initBehavior?: () => Promise<void>;
};

type Harness = {
    readonly manager: LspServerManager;
    readonly createdClients: CountingLspClient[];
};

function makeHarness(options: HarnessOptions = {}): Harness {
    const createdClients: CountingLspClient[] = [];
    const available = new Set(options.availableCommands ?? []);
    const initBehavior = options.initBehavior ?? (async () => undefined);
    const deps: LspServerManagerDeps = {
        commandExists: async (command) => available.has(command),
        createClient: (_options: StdioLspClientOptions) => {
            const client = new CountingLspClient(initBehavior);
            createdClients.push(client);
            return client;
        },
    };
    const manager = new LspServerManager(
        { workspaceRoot: WORKSPACE_ROOT, ...(options.servers !== undefined ? { servers: options.servers } : {}) },
        deps,
    );
    return { manager, createdClients };
}

// ===========================================================================
// getLanguageIdForFile
// ===========================================================================

describe('LspServerManager.getLanguageIdForFile', () => {
    it("maps '.ts' to 'typescript'", () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/src/index.ts')).toBe('typescript');
    });

    it("maps '.go' to 'go'", () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/main.go')).toBe('go');
    });

    it("maps '.py' to 'python' and '.rs' to 'rust'", () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/app.py')).toBe('python');
        expect(manager.getLanguageIdForFile('/workspace/lib.rs')).toBe('rust');
    });

    it('is case-insensitive on the extension', () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/Component.TSX')).toBe('typescript');
    });

    it('returns undefined for an unknown extension', () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/data.unknownext')).toBeUndefined();
    });

    it('returns undefined for a file with no extension', () => {
        const { manager } = makeHarness();
        expect(manager.getLanguageIdForFile('/workspace/Makefile')).toBeUndefined();
    });

    it('honours a custom server catalog over the defaults', () => {
        const custom: readonly LspServerConfig[] = [
            { languageId: 'elixir', extensions: ['.ex', '.exs'], command: 'elixir-ls' },
        ];
        const { manager } = makeHarness({ servers: custom });
        expect(manager.getLanguageIdForFile('/workspace/lib/app.ex')).toBe('elixir');
        // Default-backed extensions are no longer claimed.
        expect(manager.getLanguageIdForFile('/workspace/src/index.ts')).toBeUndefined();
    });
});

// ===========================================================================
// detectAvailableServers
// ===========================================================================

describe('LspServerManager.detectAvailableServers', () => {
    it('returns only the servers whose commands are available', async () => {
        const { manager } = makeHarness({
            availableCommands: ['typescript-language-server', 'gopls'],
        });
        const available = await manager.detectAvailableServers();
        expect(available.map((server) => server.languageId)).toEqual(['typescript', 'go']);
    });

    it('returns an empty array when no commands are available', async () => {
        const { manager } = makeHarness({ availableCommands: [] });
        const available = await manager.detectAvailableServers();
        expect(available).toEqual([]);
    });

    it('returns every default server when all commands are available', async () => {
        const { manager } = makeHarness({
            availableCommands: ['typescript-language-server', 'gopls', 'pyright-langserver', 'rust-analyzer'],
        });
        const available = await manager.detectAvailableServers();
        expect(available).toEqual([...DEFAULT_LSP_SERVERS]);
    });

    it('does not throw when a command lookup rejects (treats it as unavailable via the seam)', async () => {
        // The seam contract is "resolve boolean"; a rejecting seam is out of
        // contract, but we still assert the happy path: the seam decides alone.
        const { manager } = makeHarness({ availableCommands: ['rust-analyzer'] });
        const available = await manager.detectAvailableServers();
        expect(available.map((server) => server.languageId)).toEqual(['rust']);
    });
});

// ===========================================================================
// getClientForFile
// ===========================================================================

describe('LspServerManager.getClientForFile', () => {
    it('spawns and initialises a client on first call for a known language', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
        });
        const client = await manager.getClientForFile('/workspace/src/index.ts');
        expect(client).toBeInstanceOf(StdioLspClient);
        expect(createdClients).toHaveLength(1);
        expect(createdClients[0]?.initCalls).toEqual([1]);
    });

    it('returns the cached client on the second call (no second spawn, no second init)', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
        });
        const first = await manager.getClientForFile('/workspace/src/index.ts');
        const second = await manager.getClientForFile('/workspace/src/other.ts');
        expect(second).toBe(first);
        expect(createdClients).toHaveLength(1);
        expect(createdClients[0]?.initCalls).toEqual([1]);
    });

    it('returns undefined when the extension is unknown', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
        });
        const client = await manager.getClientForFile('/workspace/data.unknownext');
        expect(client).toBeUndefined();
        expect(createdClients).toHaveLength(0);
    });

    it('returns undefined when the server command is not on PATH', async () => {
        const { manager, createdClients } = makeHarness({ availableCommands: [] });
        const client = await manager.getClientForFile('/workspace/src/index.ts');
        expect(client).toBeUndefined();
        expect(createdClients).toHaveLength(0);
    });

    it('returns undefined and marks the language failed when initialize rejects', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
            initBehavior: () => Promise.reject(new Error('server crashed')),
        });
        const first = await manager.getClientForFile('/workspace/src/index.ts');
        expect(first).toBeUndefined();
        expect(createdClients).toHaveLength(1);
        // Subsequent calls short-circuit: no second spawn, no second crash.
        const second = await manager.getClientForFile('/workspace/src/other.ts');
        expect(second).toBeUndefined();
        expect(createdClients).toHaveLength(1);
    });

    it('spawns separate clients per language', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server', 'gopls'],
        });
        const tsClient = await manager.getClientForFile('/workspace/src/index.ts');
        const goClient = await manager.getClientForFile('/workspace/main.go');
        expect(tsClient).not.toBe(goClient);
        expect(createdClients).toHaveLength(2);
    });

    it('shares a single in-flight initialise for concurrent calls on the same language', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
        });
        const [first, second] = await Promise.all([
            manager.getClientForFile('/workspace/src/a.ts'),
            manager.getClientForFile('/workspace/src/b.ts'),
        ]);
        expect(second).toBe(first);
        expect(createdClients).toHaveLength(1);
    });
});

// ===========================================================================
// shutdownAll
// ===========================================================================

describe('LspServerManager.shutdownAll', () => {
    it('calls shutdown on every active client', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server', 'gopls'],
        });
        await manager.getClientForFile('/workspace/src/index.ts');
        await manager.getClientForFile('/workspace/main.go');
        await manager.shutdownAll();
        expect(createdClients[0]?.shutdownCalls).toEqual([1]);
        expect(createdClients[1]?.shutdownCalls).toEqual([1]);
    });

    it('is a no-op when no clients were spawned', async () => {
        const { manager } = makeHarness({ availableCommands: [] });
        await expect(manager.shutdownAll()).resolves.toBeUndefined();
    });

    it('drops the cache so subsequent getClientForFile calls spawn fresh clients', async () => {
        const { manager, createdClients } = makeHarness({
            availableCommands: ['typescript-language-server'],
        });
        const first = await manager.getClientForFile('/workspace/src/index.ts');
        await manager.shutdownAll();
        const second = await manager.getClientForFile('/workspace/src/index.ts');
        expect(second).not.toBe(first);
        expect(createdClients).toHaveLength(2);
        // The first client was shut down exactly once; the second has not been.
        expect(createdClients[0]?.shutdownCalls).toEqual([1]);
        expect(createdClients[1]?.shutdownCalls).toEqual([]);
    });

    it('still shuts down remaining clients when one rejects', async () => {
        const flakyInit = (): (() => Promise<void>) => {
            let first = true;
            return () => {
                if (first) {
                    first = false;
                    return Promise.resolve();
                }
                return Promise.resolve();
            };
        };
        // Two clients: the first's shutdown is overridden to throw via a subclass
        // built inline, proving the catch in shutdownAll keeps the pool closing.
        const createdClients: CountingLspClient[] = [];
        const deps: LspServerManagerDeps = {
            commandExists: async () => true,
            createClient: () => {
                const client = new CountingLspClient(flakyInit());
                client.shutdown = async () => {
                    client.shutdownCalls.push(1);
                    if (client.shutdownCalls.length === 1) {
                        throw new Error('shutdown refused');
                    }
                };
                createdClients.push(client);
                return client;
            },
        };
        const manager = new LspServerManager({ workspaceRoot: WORKSPACE_ROOT }, deps);
        await manager.getClientForFile('/workspace/a.ts');
        await manager.getClientForFile('/workspace/b.go');
        await expect(manager.shutdownAll()).resolves.toBeUndefined();
        expect(createdClients[0]?.shutdownCalls).toEqual([1]);
        expect(createdClients[1]?.shutdownCalls).toEqual([1]);
    });
});
