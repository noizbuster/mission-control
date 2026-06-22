import { z } from 'zod';
import { type AbgGraphSpec, AbgGraphSpecSchema } from './abg.js';
import { type Category, CategorySchema } from './category.js';
import { type Mode, ModeSchema } from './mode.js';

/**
 * A named, deployable workflow: an ABG graph spec wrapped with discovery metadata plus optional
 * mode and category presets. Discovered from `.mctrl/workflows/` / `.agents/workflows/` /
 * `<config-dir>/workflows/` as `*.workflow.json(c)` (Task 2.1), invoked via `#name {prompt}`
 * (Task 2.2), and self-invokable by the model via the `workflow(name, prompt)` tool (Task 3.10).
 */
export const WorkflowSpecSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().optional(),
        graph: AbgGraphSpecSchema,
        modes: z.array(ModeSchema).optional(),
        categories: z.array(CategorySchema).optional(),
    })
    .strict();
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export const WORKFLOW_DISCOVERY_DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export const WorkflowDiscoveryDiagnosticSeveritySchema = z.enum(WORKFLOW_DISCOVERY_DIAGNOSTIC_SEVERITIES);
export type WorkflowDiscoveryDiagnosticSeverity = z.infer<typeof WorkflowDiscoveryDiagnosticSeveritySchema>;

/**
 * A non-fatal diagnostic emitted by the workflow loader (Task 2.1) when a discovered workflow
 * file fails validation or violates a constraint. The loader never throws; it collects these and
 * surfaces them to the CLI/desktop for reporting, mirroring the skill-loader diagnostic pattern.
 */
export const WorkflowDiscoveryDiagnosticSchema = z
    .object({
        workflowName: z.string().min(1),
        severity: WorkflowDiscoveryDiagnosticSeveritySchema,
        code: z.string().min(1),
        message: z.string().min(1),
        path: z.string().min(1).optional(),
    })
    .strict();
export type WorkflowDiscoveryDiagnostic = z.infer<typeof WorkflowDiscoveryDiagnosticSchema>;

export type { AbgGraphSpec, Category, Mode };
