import { z } from 'zod';

export const SESSION_TREE_EVENT_TYPES = [
    'session.metadata.updated',
    'session.tree.entry',
    'session.tree.active_leaf',
    'session.forked',
    'session.cloned',
    'session.compacted',
    'session.exported',
    'session.imported',
] as const;

export const SESSION_ARCHIVE_SCHEMA_VERSION = 1;
export const SESSION_ARCHIVE_FILE_KIND = 'mission-control.session-archive';
export const SESSION_ARCHIVE_FILE_VERSION = 1;

export const SessionTreeEventTypeSchema = z.enum(SESSION_TREE_EVENT_TYPES);
export type SessionTreeEventType = z.infer<typeof SessionTreeEventTypeSchema>;

const SessionTreeIdSchema = z.string().min(1);
const SessionIdSchema = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/);
const SessionWorkspaceTrustSchema = z.enum(['trusted', 'denied', 'unknown']);

export const SessionTreeSourceSchema = z
    .object({
        sessionId: SessionIdSchema,
        entryId: SessionTreeIdSchema.optional(),
    })
    .strict();
export type SessionTreeSource = z.infer<typeof SessionTreeSourceSchema>;

export const SessionArchiveManifestSchema = z
    .object({
        schemaVersion: z.literal(SESSION_ARCHIVE_SCHEMA_VERSION),
        sessionId: SessionIdSchema,
        cwd: z.string().min(1),
        trustedRoot: z.string().min(1),
        createdAt: z.string().datetime(),
    })
    .strict();
export type SessionArchiveManifest = z.infer<typeof SessionArchiveManifestSchema>;

export const SessionTreeEntryMetadataSchema = z
    .object({
        kind: z.literal('entry'),
        entryId: SessionTreeIdSchema,
        parentEntryId: SessionTreeIdSchema.optional(),
        active: z.boolean().optional(),
    })
    .strict();
export type SessionTreeEntryMetadata = z.infer<typeof SessionTreeEntryMetadataSchema>;

export const SessionTreeMetadataUpdateSchema = z
    .object({
        kind: z.literal('metadata'),
        name: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        trustedRoot: z.string().min(1).optional(),
        workspaceTrust: SessionWorkspaceTrustSchema.optional(),
        parentSessionId: SessionIdSchema.optional(),
    })
    .strict();
export type SessionTreeMetadataUpdate = z.infer<typeof SessionTreeMetadataUpdateSchema>;

export const SessionTreeSourceMetadataSchema = z
    .object({
        kind: z.enum(['fork', 'clone']),
        parentSessionId: SessionIdSchema.optional(),
        source: SessionTreeSourceSchema,
    })
    .strict();
export type SessionTreeSourceMetadata = z.infer<typeof SessionTreeSourceMetadataSchema>;

export const SessionTreeActiveLeafMetadataSchema = z
    .object({
        kind: z.literal('active_leaf'),
        entryId: SessionTreeIdSchema,
    })
    .strict();
export type SessionTreeActiveLeafMetadata = z.infer<typeof SessionTreeActiveLeafMetadataSchema>;

export const SessionCompactionBoundaryMetadataSchema = z
    .object({
        kind: z.literal('compaction'),
        boundaryEntryId: SessionTreeIdSchema,
        firstKeptEntryId: SessionTreeIdSchema,
        boundarySequence: z.number().int().nonnegative().optional(),
        firstKeptSequence: z.number().int().nonnegative().optional(),
        summary: z.string().min(1).optional(),
    })
    .strict();
export type SessionCompactionBoundaryMetadata = z.infer<typeof SessionCompactionBoundaryMetadataSchema>;

export const SessionArchiveExportMetadataSchema = z
    .object({
        kind: z.literal('export'),
        manifest: SessionArchiveManifestSchema,
    })
    .strict();
export type SessionArchiveExportMetadata = z.infer<typeof SessionArchiveExportMetadataSchema>;

export const SessionArchiveImportMetadataSchema = z
    .object({
        kind: z.literal('import'),
        manifest: SessionArchiveManifestSchema,
        sourceSessionId: SessionIdSchema.optional(),
    })
    .strict();
export type SessionArchiveImportMetadata = z.infer<typeof SessionArchiveImportMetadataSchema>;

export const SessionArchiveChecksumSchema = z
    .object({
        algorithm: z.literal('sha256'),
        value: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export type SessionArchiveChecksum = z.infer<typeof SessionArchiveChecksumSchema>;

export const SessionArchiveFileSchema = z
    .object({
        kind: z.literal(SESSION_ARCHIVE_FILE_KIND),
        version: z.literal(SESSION_ARCHIVE_FILE_VERSION),
        manifest: SessionArchiveManifestSchema,
        checksum: SessionArchiveChecksumSchema,
        eventsJsonl: z.string().min(1),
    })
    .strict();
export type SessionArchiveFile = z.infer<typeof SessionArchiveFileSchema>;

export const SessionTreeEventMetadataSchema = z.discriminatedUnion('kind', [
    SessionTreeEntryMetadataSchema,
    SessionTreeMetadataUpdateSchema,
    SessionTreeSourceMetadataSchema,
    SessionTreeActiveLeafMetadataSchema,
    SessionCompactionBoundaryMetadataSchema,
    SessionArchiveExportMetadataSchema,
    SessionArchiveImportMetadataSchema,
]);
export type SessionTreeEventMetadata = z.infer<typeof SessionTreeEventMetadataSchema>;
