import { z } from 'zod';
import { type AbgNodeModelOptions, AbgNodeModelOptionsSchema } from './abg.js';
import { type PermissionKind, PermissionKindSchema } from './permission-profile.js';

/**
 * A task() category preset: the capability/model/tool surface a category of sub-agent runs with.
 *
 * Categories (Task 1.8) are the collapsed "specialist" dimension — `quick`, `deep`, `ultrabrain`,
 * `explore`, `oracle`, `librarian`, etc. Each carries a model preset, the permission kinds its
 * child sessions are allowed to exercise, an optional system-prompt addendum, and an optional
 * tool allowlist narrowing the built-in registry.
 */
export const CategorySchema = z
    .object({
        id: z.string().min(1),
        model: AbgNodeModelOptionsSchema.optional(),
        permissions: z.array(PermissionKindSchema),
        systemPromptAddendum: z.string().min(1).optional(),
        tools: z.array(z.string().min(1)).optional(),
    })
    .strict();
export type Category = z.infer<typeof CategorySchema>;

/** A catalog of named categories, indexed by id at runtime. */
export const CategoryCatalogSchema = z
    .object({
        categories: z.array(CategorySchema).default([]),
    })
    .strict();
export type CategoryCatalog = z.infer<typeof CategoryCatalogSchema>;

export type { AbgNodeModelOptions, PermissionKind };
