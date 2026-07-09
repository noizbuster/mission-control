import { z } from 'zod';

export const TUI_PLUGIN_CAPABILITIES = [
    'ui.slot',
    'ui.route',
    'ui.command',
    'ui.dialog',
    'ui.theme',
    'ui.kv',
    'keymap.register',
    'runtime.events.read',
] as const;
export const TuiPluginCapabilityIdSchema = z.enum(TUI_PLUGIN_CAPABILITIES);
export type TuiPluginCapabilityId = z.infer<typeof TuiPluginCapabilityIdSchema>;

export const TuiPluginSlotDescriptorSchema = z
    .object({
        id: z.string().min(1),
        slot: z.string().min(1),
        label: z.string().min(1),
        componentRef: z.string().min(1),
        order: z.number().finite().optional(),
    })
    .strict();
export type TuiPluginSlotDescriptor = z.infer<typeof TuiPluginSlotDescriptorSchema>;

export const TuiPluginRouteDescriptorSchema = z
    .object({
        id: z.string().min(1),
        path: z.string().min(1),
        label: z.string().min(1),
        order: z.number().finite().optional(),
    })
    .strict();
export type TuiPluginRouteDescriptor = z.infer<typeof TuiPluginRouteDescriptorSchema>;

export const TuiPluginCommandDescriptorSchema = z
    .object({
        id: z.string().min(1),
        title: z.string().min(1),
        defaultKeybinding: z.string().min(1).optional(),
        paletteSection: z.string().min(1).optional(),
    })
    .strict();
export type TuiPluginCommandDescriptor = z.infer<typeof TuiPluginCommandDescriptorSchema>;

export const TuiPluginCapabilitySchema = z
    .object({
        pluginName: z.string().min(1),
        capability: TuiPluginCapabilityIdSchema,
        enabled: z.boolean(),
        description: z.string().min(1).optional(),
    })
    .strict();
export type TuiPluginCapability = z.infer<typeof TuiPluginCapabilitySchema>;

export const TuiPluginManifestSchema = z
    .object({
        name: z.string().min(1),
        version: z.string().min(1),
        capabilities: z.array(TuiPluginCapabilityIdSchema).readonly(),
        slots: z.array(TuiPluginSlotDescriptorSchema).readonly().default([]),
        routes: z.array(TuiPluginRouteDescriptorSchema).readonly().default([]),
        commands: z.array(TuiPluginCommandDescriptorSchema).readonly().default([]),
        entryPoint: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
    })
    .strict();
export type TuiPluginManifest = z.infer<typeof TuiPluginManifestSchema>;
export type TuiPluginManifestInput = z.input<typeof TuiPluginManifestSchema>;

export const TUI_PLUGIN_DIAGNOSTIC_LEVELS = ['error', 'warning', 'info'] as const;
export const TuiPluginDiagnosticLevelSchema = z.enum(TUI_PLUGIN_DIAGNOSTIC_LEVELS);
export type TuiPluginDiagnosticLevel = z.infer<typeof TuiPluginDiagnosticLevelSchema>;

export const TuiPluginDiagnosticSchema = z
    .object({
        pluginName: z.string().min(1),
        level: TuiPluginDiagnosticLevelSchema,
        code: z.string().min(1).optional(),
        message: z.string().min(1),
        redacted: z.boolean(),
        timestamp: z.number().int().nonnegative(),
    })
    .strict();
export type TuiPluginDiagnostic = z.infer<typeof TuiPluginDiagnosticSchema>;

export const TuiPluginRedactedErrorSchema = z
    .object({
        pluginName: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
        redacted: z.literal(true),
    })
    .strict();
export type TuiPluginRedactedError = z.infer<typeof TuiPluginRedactedErrorSchema>;
