import { z } from 'zod';

/**
 * Debug Adapter Protocol (DAP) adapter registry schemas.
 *
 * DAP is a JSON-RPC protocol (like LSP) for debuggers. A debug adapter translates the
 * protocol into debugger-specific commands (lldb-dap for C/C++/Rust, debugpy for Python,
 * dlv for Go, js-debug for JS/TS). This schema declares which adapters the runtime
 * recognizes; it is the catalog seam only — a real DAP stdio transport + stepping engine
 * is deferred to a follow-up plan. Until then every catalog entry carries
 * {@linkcode DapAdapter.supported} `false` (declared, not wired).
 *
 * Values that cross the protocol boundary (config files, future session metadata) are
 * validated against {@linkcode DapAdapterSchema} / {@linkcode DapAdapterRegistrySchema}.
 */
export const DapAdapterSchema = z
    .object({
        id: z.string().min(1),
        command: z.string().min(1),
        languages: z.array(z.string().min(1)),
        supported: z.boolean(),
    })
    .strict();
export type DapAdapter = z.infer<typeof DapAdapterSchema>;

export const DapAdapterRegistrySchema = z
    .object({
        adapters: z.array(DapAdapterSchema),
    })
    .strict();
export type DapAdapterRegistry = z.infer<typeof DapAdapterRegistrySchema>;

/**
 * Built-in catalog of known DAP adapters. Each is declared but NOT yet wired
 * (`supported: false`); a follow-up plan that ships a real DAP engine flips individual
 * entries to `true` as their transports are proven. Mirrors the mission-control
 * providers-without-adapters convention: catalog entries exist before execution lands.
 */
export const BUILTIN_DAP_ADAPTERS: readonly DapAdapter[] = [
    { id: 'lldb-dap', command: 'lldb-dap', languages: ['c', 'cpp', 'rust'], supported: false },
    { id: 'debugpy', command: 'debugpy-adapter', languages: ['python'], supported: false },
    { id: 'dlv', command: 'dlv', languages: ['go'], supported: false },
    { id: 'js-debug', command: 'js-debug-adapter', languages: ['javascript', 'typescript'], supported: false },
];
