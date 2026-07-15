import { z } from 'zod';

export const TUI_KV_VALUE_SCHEMA_KEYS = ['string', 'number', 'boolean', 'stringArray', 'numberArray'] as const;
export const TuiKvValueSchemaKeySchema = z.enum(TUI_KV_VALUE_SCHEMA_KEYS);
export type TuiKvValueSchemaKey = z.infer<typeof TuiKvValueSchemaKeySchema>;

const TuiStringKvEntrySchema = z
    .object({
        key: z.string().min(1),
        schemaKey: z.literal('string'),
        value: z.string(),
    })
    .strict();

const TuiNumberKvEntrySchema = z
    .object({
        key: z.string().min(1),
        schemaKey: z.literal('number'),
        value: z.number().finite(),
    })
    .strict();

const TuiBooleanKvEntrySchema = z
    .object({
        key: z.string().min(1),
        schemaKey: z.literal('boolean'),
        value: z.boolean(),
    })
    .strict();

const TuiStringArrayKvEntrySchema = z
    .object({
        key: z.string().min(1),
        schemaKey: z.literal('stringArray'),
        value: z.array(z.string()).readonly(),
    })
    .strict();

const TuiNumberArrayKvEntrySchema = z
    .object({
        key: z.string().min(1),
        schemaKey: z.literal('numberArray'),
        value: z.array(z.number().finite()).readonly(),
    })
    .strict();

export const TuiKvEntrySchema = z.discriminatedUnion('schemaKey', [
    TuiStringKvEntrySchema,
    TuiNumberKvEntrySchema,
    TuiBooleanKvEntrySchema,
    TuiStringArrayKvEntrySchema,
    TuiNumberArrayKvEntrySchema,
]);
export type TuiKvEntry = z.infer<typeof TuiKvEntrySchema>;

export const TuiKvNamespaceSchema = z
    .object({
        namespace: z.string().min(1),
        entries: z.array(TuiKvEntrySchema).readonly(),
    })
    .strict();
export type TuiKvNamespace = z.infer<typeof TuiKvNamespaceSchema>;

export const TuiVariantCyclingHintSchema = z
    .object({
        modelId: z.string().min(1),
        variantId: z.string().min(1),
    })
    .strict();
export type TuiVariantCyclingHint = z.infer<typeof TuiVariantCyclingHintSchema>;

export const TuiUiToggleSchema = z
    .object({
        key: z.string().min(1),
        value: z.boolean(),
    })
    .strict();
export type TuiUiToggle = z.infer<typeof TuiUiToggleSchema>;

export const TuiLocalPreferencesSchema = z
    .object({
        recentModels: z.array(z.string().min(1)).readonly(),
        favoriteModels: z.array(z.string().min(1)).readonly(),
        variantCyclingHints: z.array(TuiVariantCyclingHintSchema).readonly(),
        sessionPins: z.array(z.string().min(1)).readonly(),
        uiToggles: z.array(TuiUiToggleSchema).readonly(),
    })
    .strict();
export type TuiLocalPreferences = z.infer<typeof TuiLocalPreferencesSchema>;

export const TuiPromptHistoryEntrySchema = z
    .object({
        id: z.string().min(1),
        text: z.string().min(1),
        timestamp: z.number().int().nonnegative(),
    })
    .strict();
export type TuiPromptHistoryEntry = z.infer<typeof TuiPromptHistoryEntrySchema>;

export const TuiPromptStashEntrySchema = z
    .object({
        id: z.string().min(1),
        text: z.string(),
        cursorOffset: z.number().int().nonnegative(),
        timestamp: z.number().int().nonnegative(),
    })
    .strict();
export type TuiPromptStashEntry = z.infer<typeof TuiPromptStashEntrySchema>;

export const TuiFrecencyRecordSchema = z
    .object({
        key: z.string().min(1),
        accessCount: z.number().int().positive(),
        lastAccessedAt: z.number().int().nonnegative(),
        firstSeenAt: z.number().int().nonnegative(),
    })
    .strict();
export type TuiFrecencyRecord = z.infer<typeof TuiFrecencyRecordSchema>;

export const TuiThemeOverrideSchema = z
    .object({
        key: z.string().min(1),
        value: z.string(),
    })
    .strict();
export type TuiThemeOverride = z.infer<typeof TuiThemeOverrideSchema>;

export const TuiThemePreferenceSchema = z
    .object({
        activeThemeId: z.string().min(1),
        customOverrides: z.array(TuiThemeOverrideSchema).readonly(),
    })
    .strict();
export type TuiThemePreference = z.infer<typeof TuiThemePreferenceSchema>;

export {
    TUI_PLUGIN_CAPABILITIES,
    TUI_PLUGIN_DIAGNOSTIC_LEVELS,
    type TuiPluginCapability,
    type TuiPluginCapabilityId,
    TuiPluginCapabilityIdSchema,
    TuiPluginCapabilitySchema,
    type TuiPluginCommandDescriptor,
    TuiPluginCommandDescriptorSchema,
    type TuiPluginDiagnostic,
    type TuiPluginDiagnosticLevel,
    TuiPluginDiagnosticLevelSchema,
    TuiPluginDiagnosticSchema,
    type TuiPluginManifest,
    type TuiPluginManifestInput,
    TuiPluginManifestSchema,
    type TuiPluginRedactedError,
    TuiPluginRedactedErrorSchema,
    type TuiPluginRouteDescriptor,
    TuiPluginRouteDescriptorSchema,
    type TuiPluginSlotDescriptor,
    TuiPluginSlotDescriptorSchema,
} from './tui-plugin-data';
