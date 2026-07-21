/**
 * Shared soft-bias context for read-only parents that spawn `task()` children.
 *
 * Soft guidance only — does not enforce topology. Workflow mode policies stay
 * graph-scoped; children receive independent category + AgentDefinition.pathPolicies
 * authority. Prefer relative imports from workflow graph factories; not a public
 * package barrel export.
 */
export const READONLY_TASK_CHILD_CONTEXT =
    'Spawned child agents do NOT inherit workflow PolicyEffectRule sets; mode policies ' +
    'stay graph-scoped and child authority is independently constrained by the selected ' +
    'read-only category and AgentDefinition.pathPolicies. From read-only parents, route ' +
    'task() to explore, librarian, oracle, reviewer, or planner as appropriate — not ' +
    'deep, quick, or designer for write work. Prefer explore for codebase mapping; ' +
    'librarian for external docs, short reference checks, and longer research ' +
    '(librarian/oracle may use webfetch, web_search, or mcp when the category allows); ' +
    'oracle for deep analysis; reviewer for critique; planner for plan drafting. Frame ' +
    'child prompts as read-only research with TASK / DELIVERABLE / SCOPE / VERIFY, and ' +
    'treat subagent output as claims until verified.';
