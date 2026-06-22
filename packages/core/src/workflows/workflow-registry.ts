/**
 * Workflow registry: holds discovered + programmatically registered workflows,
 * categories, and modes. Resolves each by its key (`name` for workflows, `id` for
 * categories and modes). Keeps insertion order for stable `list*()`/`names()` output.
 *
 * Registration semantics (all three collections): first insertion fixes the position
 * in the order list; subsequent registrations with the same key overwrite the stored
 * value. This makes programmatic registration take precedence over discovered items
 * on collision (discovered items land in the constructor first, programmatic calls
 * overwrite their values afterwards) while preserving stable ordering.
 */
import type { Category, Mode, WorkflowSpec } from '@mission-control/protocol';

export class WorkflowRegistry {
    private readonly workflowsByName = new Map<string, WorkflowSpec>();
    private readonly workflowOrder: WorkflowSpec[] = [];
    private readonly categoriesById = new Map<string, Category>();
    private readonly categoryOrder: Category[] = [];
    private readonly modesById = new Map<string, Mode>();
    private readonly modeOrder: Mode[] = [];

    constructor(discovered: readonly WorkflowSpec[] = []) {
        for (const spec of discovered) {
            this.registerWorkflow(spec);
        }
    }

    // --- Workflows ---

    /** Backward-compatible alias for {@link registerWorkflow}. */
    register(spec: WorkflowSpec): void {
        this.registerWorkflow(spec);
    }

    registerWorkflow(spec: WorkflowSpec): void {
        if (!this.workflowsByName.has(spec.name)) {
            this.workflowOrder.push(spec);
        }
        this.workflowsByName.set(spec.name, spec);
    }

    lookup(name: string): WorkflowSpec | undefined {
        return this.workflowsByName.get(name);
    }

    list(): readonly WorkflowSpec[] {
        return [...this.workflowOrder];
    }

    names(): readonly string[] {
        return this.workflowOrder.map((spec) => spec.name);
    }

    // --- Categories ---

    registerCategory(category: Category): void {
        if (!this.categoriesById.has(category.id)) {
            this.categoryOrder.push(category);
        }
        this.categoriesById.set(category.id, category);
    }

    lookupCategory(id: string): Category | undefined {
        return this.categoriesById.get(id);
    }

    listCategories(): readonly Category[] {
        return [...this.categoryOrder];
    }

    // --- Modes ---

    registerMode(mode: Mode): void {
        if (!this.modesById.has(mode.id)) {
            this.modeOrder.push(mode);
        }
        this.modesById.set(mode.id, mode);
    }

    lookupMode(id: string): Mode | undefined {
        return this.modesById.get(id);
    }

    listModes(): readonly Mode[] {
        return [...this.modeOrder];
    }
}
