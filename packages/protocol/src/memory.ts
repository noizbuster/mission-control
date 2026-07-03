import { z } from 'zod';

/**
 * Memory backend selection schemas.
 *
 * The runtime recognizes four mutually-exclusive memory backends, selected via the
 * `memory.backend` config field. Only two have runtime implementations: `off` (the
 * default no-op state, tools not registered) and `local` (an in-memory-only stub that
 * round-trips retain -> recall within a single process). The remaining two — `mnemopi`
 * (SQLite) and `hindsight` (a remote server) — are declared as catalog entries only;
 * their execution is deferred. They mirror the mission-control providers-without-adapters
 * convention: the catalog entry exists before the engine lands, so a configured-but-
 * unported backend registers and advertises its tools but returns
 * `memory_backend_not_configured` when invoked.
 *
 * Values that cross the protocol boundary (config files, catalog listings) are validated
 * against {@linkcode MemoryBackendIdSchema} / {@linkcode MemoryBackendSchema}.
 */
export const MEMORY_BACKENDS = ['off', 'local', 'mnemopi', 'hindsight'] as const;
export type MemoryBackendId = (typeof MEMORY_BACKENDS)[number];

export const MemoryBackendIdSchema = z.enum(MEMORY_BACKENDS);

/** A single catalog entry describing a recognized memory backend. */
export const MemoryBackendSchema = z
    .object({
        id: MemoryBackendIdSchema,
        supported: z.boolean(),
        description: z.string().min(1),
    })
    .strict();
export type MemoryBackend = z.infer<typeof MemoryBackendSchema>;

export const MemoryBackendCatalogSchema = z
    .object({
        backends: z.array(MemoryBackendSchema),
    })
    .strict();
export type MemoryBackendCatalog = z.infer<typeof MemoryBackendCatalogSchema>;

/**
 * The `memory` config block shape: `{ backend: 'off' | 'local' | ... }`. Defaults to
 * `off` when the field is absent so an unconfigured runtime never registers memory tools.
 */
export const MemoryBackendConfigSchema = z
    .object({
        backend: MemoryBackendIdSchema.default('off'),
    })
    .strict();
export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;

/**
 * Built-in catalog of recognized memory backends. `off` and `local` ship runtime
 * implementations (`off` is the default no-op gate; `local` is the in-memory stub).
 * `mnemopi` and `hindsight` are catalog seams: declared so config selection and tool
 * advertisement work, but `supported: false` until a follow-up plan ports their engines.
 */
export const BUILTIN_MEMORY_BACKENDS: readonly MemoryBackend[] = [
    {
        id: 'off',
        supported: true,
        description: 'No memory subsystem. Memory tools are not registered or advertised. This is the default.',
    },
    {
        id: 'local',
        supported: true,
        description:
            'In-memory-only stub. Retain stores memories in a process-local Map; recall searches them. ' +
            'No on-disk persistence — memories are lost when the process exits.',
    },
    {
        id: 'mnemopi',
        supported: false,
        description:
            'SQLite-backed memory engine. Catalog seam only — execution deferred. Tools register and ' +
            'advertise but return memory_backend_not_configured until the engine is ported.',
    },
    {
        id: 'hindsight',
        supported: false,
        description:
            'Remote Hindsight server backend. Catalog seam only — execution deferred. Tools register and ' +
            'advertise but return memory_backend_not_configured until the engine is ported.',
    },
];
