/**
 * `LspServerManager` — detects available language servers, lazily spawns one
 * `StdioLspClient` per language ID, and hands out cached clients by file path.
 *
 * Design (mirrors the injectable-seam pattern of `lsp-stdio-client.ts` and
 * `ast-grep-runner.ts`):
 * - **Command detection** (`commandExists`) defaults to `which`/`where` via
 *   `execFile`; tests inject a pure mock so no real process is spawned.
 * - **Client creation** (`createClient`) defaults to constructing a real
 *   `StdioLspClient`; tests inject a subclass instance to record calls.
 * - Clients are cached by language ID. Detection results inside `getClientForFile`
 *   are memoised so repeated queries for an unavailable server do not re-spawn
 *   `which` on every file; `detectAvailableServers` always re-checks so an
 *   explicit probe stays truthful.
 * - A failed initialize marks the language ID permanently failed for this
 *   manager's lifetime (no wasteful retry loop); construct a new manager to
 *   re-probe.
 */

import type { StdioLspClientOptions } from './lsp-stdio-client.js';
import { StdioLspClient } from './lsp-stdio-client.js';
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config + defaults
// ---------------------------------------------------------------------------

export type LspServerConfig = {
    /** LSP language ID, e.g. `typescript`, `go`, `python`, `rust`. */
    readonly languageId: string;
    /** File extensions (lowercased, dot-prefixed) that map to this language. */
    readonly extensions: readonly string[];
    /** Executable to spawn, e.g. `typescript-language-server` or `gopls`. */
    readonly command: string;
    /** Args passed to the server binary. Omit to spawn with no args. */
    readonly args?: readonly string[];
};

/**
 * Built-in language-server catalog. Each entry pairs a language ID + extensions
 * with the canonical stdio server command. `detectAvailableServers` /
 * `getClientForFile` only surface entries whose command resolves on PATH.
 */
export const DEFAULT_LSP_SERVERS: readonly LspServerConfig[] = [
    {
        languageId: 'typescript',
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
        command: 'typescript-language-server',
        args: ['--stdio'],
    },
    { languageId: 'go', extensions: ['.go'], command: 'gopls', args: ['serve'] },
    { languageId: 'python', extensions: ['.py'], command: 'pyright-langserver', args: ['--stdio'] },
    { languageId: 'rust', extensions: ['.rs'], command: 'rust-analyzer' },
];

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Resolves to `true` when `command` is executable on PATH. */
export type CommandExists = (command: string) => Promise<boolean>;

/** Constructs a `StdioLspClient` from spawn options. Default builds a real client. */
export type LspClientFactory = (options: StdioLspClientOptions) => StdioLspClient;

export type LspServerManagerOptions = {
    /** Absolute workspace root advertised to each spawned server. */
    readonly workspaceRoot: string;
    /** Override the default server catalog. Defaults to `DEFAULT_LSP_SERVERS`. */
    readonly servers?: readonly LspServerConfig[];
};

/** Internal test/override dependencies. All optional; defaults are production paths. */
export type LspServerManagerDeps = {
    readonly commandExists?: CommandExists;
    readonly createClient?: LspClientFactory;
};

const LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which';

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class LspServerManager {
    private readonly workspaceRoot: string;
    private readonly servers: readonly LspServerConfig[];
    private readonly commandExists: CommandExists;
    private readonly createClient: LspClientFactory;

    private readonly clients = new Map<string, StdioLspClient>();
    private readonly pendingClients = new Map<string, Promise<StdioLspClient | undefined>>();
    private readonly failedLanguageIds = new Set<string>();
    private readonly commandAvailability = new Map<string, boolean>();

    constructor(options: LspServerManagerOptions, deps?: LspServerManagerDeps) {
        this.workspaceRoot = options.workspaceRoot;
        this.servers = options.servers ?? DEFAULT_LSP_SERVERS;
        this.commandExists = deps?.commandExists ?? defaultCommandExists;
        this.createClient = deps?.createClient ?? defaultClientFactory;
    }

    /**
     * Language ID for a file path derived from its extension, or `undefined` when
     * no configured server claims the extension. Case-insensitive on the extension.
     */
    getLanguageIdForFile(filePath: string): string | undefined {
        const extension = pathExtension(filePath);
        if (extension === '') return undefined;
        for (const server of this.servers) {
            if (server.extensions.includes(extension)) return server.languageId;
        }
        return undefined;
    }

    /**
     * Probe PATH for every configured server command. Always re-checks (does not
     * read the internal availability cache) so an explicit probe stays truthful
     * even if `getClientForFile` previously memoised a negative result.
     */
    async detectAvailableServers(): Promise<readonly LspServerConfig[]> {
        const checked = await Promise.all(
            this.servers.map(async (server) => ({
                server,
                exists: await this.commandExists(server.command),
            })),
        );
        const available: LspServerConfig[] = [];
        for (const { server, exists } of checked) {
            if (exists) {
                available.push(server);
                this.commandAvailability.set(server.command, true);
            }
        }
        return available;
    }

    /**
     * Return the cached `StdioLspClient` for the file's language, spawning and
     * initialising one on first use. Returns `undefined` when the extension is
     * unknown, the server command is absent from PATH, or a prior initialise
     * failed for that language. Concurrent calls for the same language share a
     * single in-flight initialise to avoid double-spawning.
     */
    async getClientForFile(filePath: string): Promise<StdioLspClient | undefined> {
        const languageId = this.getLanguageIdForFile(filePath);
        if (languageId === undefined) return undefined;
        if (this.failedLanguageIds.has(languageId)) return undefined;

        const cached = this.clients.get(languageId);
        if (cached !== undefined) return cached;

        const pending = this.pendingClients.get(languageId);
        if (pending !== undefined) return pending;

        const promise = this.spawnClientForLanguage(languageId);
        this.pendingClients.set(languageId, promise);
        try {
            const client = await promise;
            if (client !== undefined) this.clients.set(languageId, client);
            return client;
        } finally {
            this.pendingClients.delete(languageId);
        }
    }

    /** Send `shutdown` to every active client in parallel, then drop the cache. */
    async shutdownAll(): Promise<void> {
        const clients = [...this.clients.values()];
        this.clients.clear();
        await Promise.all(
            clients.map((client) =>
                client.shutdown().catch(() => {
                    // Best-effort teardown: a server that refuses shutdown must not
                    // prevent the rest of the pool from closing.
                }),
            ),
        );
    }

    // ----- internal -----

    private findServerForLanguage(languageId: string): LspServerConfig | undefined {
        for (const server of this.servers) {
            if (server.languageId === languageId) return server;
        }
        return undefined;
    }

    private async isCommandAvailable(command: string): Promise<boolean> {
        const cached = this.commandAvailability.get(command);
        if (cached !== undefined) return cached;
        const exists = await this.commandExists(command);
        this.commandAvailability.set(command, exists);
        return exists;
    }

    private async spawnClientForLanguage(languageId: string): Promise<StdioLspClient | undefined> {
        const server = this.findServerForLanguage(languageId);
        if (server === undefined) return undefined;

        const available = await this.isCommandAvailable(server.command);
        if (!available) return undefined;

        const client = this.createClient({
            command: server.command,
            ...(server.args !== undefined ? { args: server.args } : {}),
            workspaceRoot: this.workspaceRoot,
        });

        try {
            await client.initialize();
        } catch {
            // Mark the language as failed for this manager's lifetime so repeated
            // queries short-circuit instead of re-spawning a broken server.
            this.failedLanguageIds.add(languageId);
            return undefined;
        }

        return client;
    }
}

// ---------------------------------------------------------------------------
// Helpers + default seams
// ---------------------------------------------------------------------------

/** Lowercased, dot-prefixed extension of the final path segment, or `''`. */
function pathExtension(filePath: string): string {
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const base = slash === -1 ? filePath : filePath.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    if (dot === -1) return '';
    return base.slice(dot).toLowerCase();
}

const defaultCommandExists: CommandExists = (command) =>
    new Promise((resolve) => {
        execFile(LOOKUP_COMMAND, [command], (error) => {
            resolve(error === null);
        });
    });

const defaultClientFactory: LspClientFactory = (options) => new StdioLspClient(options);
