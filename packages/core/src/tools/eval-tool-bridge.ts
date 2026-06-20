/**
 * Eval tool re-entry bridge (Task 21).
 *
 * Allows the eval sandbox to call host agent tools (read, grep, etc.) from inside
 * the VM. The bridge sits between the worker's `tool-call` messages and the host
 * tool registry, enforcing the same recursion guard as the `task` subagent: no
 * `eval`, no `task`, no `mcp__*`. Only read-only tools are surfaced.
 *
 * Standalone in this iteration: Task 20's context manager does not yet drive
 * `tool-call`/`tool-reply` over the worker boundary, so the bridge is a pure
 * policy + dispatch module that Task 23 will wire into the eval execution path.
 */

/** Read-only tools the sandbox may re-enter. Mirrors the read-class tool surface. */
const ALLOWED_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'read',
    'ls',
    'grep',
    'find',
    'glob',
    'repo.read',
    'repo.list',
    'repo.search',
]);

/** Tools explicitly blocked from eval re-entry, matching the `task` subagent surface. */
const BLOCKED_REENTRY_TOOLS: ReadonlySet<string> = new Set(['eval', 'task']);

const MCP_NAMESPACED_PREFIX = 'mcp__';

export type EvalToolBridgeOptions = {
    /** Dispatch an allowed tool call to the host tool registry. */
    readonly invokeTool: (name: string, args: unknown) => Promise<unknown>;
};

export type EvalToolBridge = {
    /**
     * Called by the eval context manager when the worker requests a tool call.
     * Throws if the tool is not on the eval re-entry allowlist.
     */
    readonly handleToolCall: (name: string, args: unknown) => Promise<unknown>;
    /** Whether a tool is allowed for eval re-entry. */
    readonly isToolAllowed: (name: string) => boolean;
};

export function createEvalToolBridge(options: EvalToolBridgeOptions): EvalToolBridge {
    const invokeTool = options.invokeTool;

    function isToolAllowed(name: string): boolean {
        if (BLOCKED_REENTRY_TOOLS.has(name)) {
            return false;
        }
        if (name.startsWith(MCP_NAMESPACED_PREFIX)) {
            return false;
        }
        return ALLOWED_READ_ONLY_TOOLS.has(name);
    }

    async function handleToolCall(name: string, args: unknown): Promise<unknown> {
        if (!isToolAllowed(name)) {
            throw new Error(`eval re-entry blocked for tool: ${name}`);
        }
        return invokeTool(name, args);
    }

    return { handleToolCall, isToolAllowed };
}
