import { z } from 'zod';

export const MODEL_CATALOG_STATUSES = ['active', 'deprecated'] as const;

export const ModelCatalogStatusSchema = z.enum(MODEL_CATALOG_STATUSES);
export type ModelCatalogStatus = z.infer<typeof ModelCatalogStatusSchema>;

export const ModelVariantEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: ModelCatalogStatusSchema.default('active'),
});
export type ModelVariantEntry = z.infer<typeof ModelVariantEntrySchema>;

export const ModelProviderSelectionSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
});
export type ModelProviderSelection = z.infer<typeof ModelProviderSelectionSchema>;

export const ProviderApiKeyCredentialSchema = z.object({
    providerID: z.string().min(1),
    type: z.literal('apiKey'),
    apiKey: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type ProviderApiKeyCredential = z.infer<typeof ProviderApiKeyCredentialSchema>;

export const ProviderCredentialFieldSchema = z.object({
    value: z.string().min(1),
    secret: z.boolean(),
});
export type ProviderCredentialField = z.infer<typeof ProviderCredentialFieldSchema>;

export const ProviderFieldsCredentialSchema = z.object({
    providerID: z.string().min(1),
    type: z.literal('fields'),
    fields: z
        .record(z.string().min(1), ProviderCredentialFieldSchema)
        .refine((fields) => Object.keys(fields).length > 0, 'credential fields must not be empty'),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type ProviderFieldsCredential = z.infer<typeof ProviderFieldsCredentialSchema>;

export const ProviderOAuthCredentialSchema = z.object({
    providerID: z.string().min(1),
    type: z.literal('oauth'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
    scopes: z.array(z.string().min(1)).optional(),
    accountLabel: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type ProviderOAuthCredential = z.infer<typeof ProviderOAuthCredentialSchema>;

export const ProviderCredentialSchema = z.discriminatedUnion('type', [
    ProviderApiKeyCredentialSchema,
    ProviderFieldsCredentialSchema,
    ProviderOAuthCredentialSchema,
]);
export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;

export const ProviderAuthFileSchema = z.object({
    $schema: z.string().url(),
    default: ModelProviderSelectionSchema.optional(),
    credentials: z.record(z.string().min(1), ProviderCredentialSchema),
});
export type ProviderAuthFile = z.infer<typeof ProviderAuthFileSchema>;

export const ProviderCredentialSummarySchema = z.object({
    providerID: z.string().min(1),
    authenticated: z.boolean(),
    credentialType: z.enum(['apiKey', 'fields', 'oauth']).optional(),
    maskedCredential: z.string().optional(),
    credentialFieldCount: z.number().int().nonnegative().optional(),
});
export type ProviderCredentialSummary = z.infer<typeof ProviderCredentialSummarySchema>;

export const ModelCatalogEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: ModelCatalogStatusSchema.default('active'),
    variants: z.array(ModelVariantEntrySchema).optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ProviderCatalogEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    defaultModelID: z.string().min(1),
    authLabel: z.string().min(1),
    models: z.array(ModelCatalogEntrySchema).min(1),
});
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;
