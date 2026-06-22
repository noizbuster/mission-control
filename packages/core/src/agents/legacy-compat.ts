/**
 * Legacy `task()` signature adapters (todo 35).
 *
 * Maps the two legacy call shapes onto the new `task(agent:, assignment:)`
 * signature so existing callers continue to work during the Wave 6 migration:
 *
 * - `task(category: "deep", prompt: "X")`     -> `{agent: "deep", assignment: "X"}`
 * - `task(description: "X", prompt: "Y")`     -> `{agent: "deep", assignment: "Y", role: "X"}`
 *
 * The XOR between `category`, `subagent_type`, and `agent` is enforced upstream
 * by `taskToolInputSchema` (see `../tools/task/task-tool.ts`). These functions
 * receive already-valid input and perform pure mapping only — no side effects,
 * no I/O. `adaptLegacySimpleInput` trims the description and omits `role`
 * entirely when the result is empty, so downstream consumers never see a
 * meaningless label.
 */

export function adaptLegacyCategoryInput(input: {
    readonly category?: string;
    readonly subagent_type?: string;
    readonly prompt: string;
}): { readonly agent: string; readonly assignment: string } {
    return { agent: input.category ?? input.subagent_type ?? 'deep', assignment: input.prompt };
}

export function adaptLegacySimpleInput(input: { readonly description: string; readonly prompt: string }): {
    readonly agent: string;
    readonly assignment: string;
    readonly role?: string;
} {
    const role = input.description.trim();
    return {
        agent: 'deep',
        assignment: input.prompt,
        ...(role.length > 0 ? { role } : {}),
    };
}
