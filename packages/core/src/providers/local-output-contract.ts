/**
 * Deterministic local-provider contracts for workflow system prompts.
 * Supports plan-first default nodes and fixer intent/research/guard nodes.
 */

// --- Fixer implementer contracts (intent-gated coding path) ---
const FIXER_INTENT_GATE_PREFIX = 'You are the intent gate for the fixer workflow.';
const INTENT_GATE_OUTPUT_CONTRACT = 'Output ONLY one class name';
const RESEARCH_GATE_PREFIX = 'Exploratory/research intent.';
const RESEARCH_GATE_OUTPUT_CONTRACT = 'Output ONLY the JSON boolean `true` when complete';
const DELEGATION_GUARD_PREFIX = 'Two checks before delegation:';
const DELEGATION_GUARD_OUTPUT_CONTRACT = 'Output ONLY `true` or `false`';

// --- Plan-first default / planner contracts ---
const PLAN_INTAKE_PREFIX = 'You are a planning consultant. Summarize the user request';
const PLAN_INTAKE_GOAL = 'Summarize the user request into a concise GOAL';
const AMBIGUITY_PREFIX = 'Classify the request ambiguity';
const EXPLORE_FILTER_PREFIX = 'Second filter within the clear branch';
const EXPLORE_COMPLETE_CONTRACT = 'Output ONLY the JSON boolean `true` when complete';
const RESEARCH_UNCLEAR_PREFIX = 'The request outcome is fuzzy';
const ADOPT_DEFAULTS_PREFIX = 'Record each adopted best-practice default';
const DRAFT_PLAN_PREFIX = 'Draft the plan as .omo/drafts/';
const DRAFT_PLAN_EXEC_PREFIX = 'Draft an execution-ready plan as .omo/drafts/';
const APPROVAL_GATE_CONTRACT = 'Output ONLY the JSON boolean `true` when the user explicitly approves';
const WRITE_PLAN_PREFIX = 'Only reached AFTER approval';

export function localOutputForSystemContract(systemPrompt: string, userPrompt: string): string | undefined {
    if (systemPrompt.startsWith(FIXER_INTENT_GATE_PREFIX) && systemPrompt.includes(INTENT_GATE_OUTPUT_CONTRACT)) {
        return classifyIntent(userPrompt);
    }
    if (systemPrompt.startsWith(RESEARCH_GATE_PREFIX) && systemPrompt.includes(RESEARCH_GATE_OUTPUT_CONTRACT)) {
        return 'true';
    }
    if (systemPrompt.includes(DELEGATION_GUARD_PREFIX) && systemPrompt.includes(DELEGATION_GUARD_OUTPUT_CONTRACT)) {
        return 'false';
    }

    if (systemPrompt.startsWith(PLAN_INTAKE_PREFIX) || systemPrompt.includes(PLAN_INTAKE_GOAL)) {
        return 'true';
    }
    if (systemPrompt.startsWith(AMBIGUITY_PREFIX) || systemPrompt.includes('ambiguity.classification')) {
        return classifyAmbiguity(userPrompt);
    }
    if (systemPrompt.startsWith(EXPLORE_FILTER_PREFIX) || systemPrompt.includes('explore.decision')) {
        return classifyExploreDecision(userPrompt);
    }
    if (
        systemPrompt.includes(EXPLORE_COMPLETE_CONTRACT) &&
        (systemPrompt.includes('Explore the relevant') ||
            systemPrompt.startsWith(RESEARCH_UNCLEAR_PREFIX) ||
            systemPrompt.includes('Deep exploration'))
    ) {
        return 'true';
    }
    if (systemPrompt.startsWith(ADOPT_DEFAULTS_PREFIX) || systemPrompt.includes('defaults.adopted when complete')) {
        return 'true';
    }
    // Intentionally no auto-complete for ask-one-question: auto-true re-enters
    // assess-ambiguity and can loop under offline local providers.
    if (systemPrompt.startsWith(DRAFT_PLAN_PREFIX) || systemPrompt.startsWith(DRAFT_PLAN_EXEC_PREFIX)) {
        return 'true';
    }
    if (systemPrompt.includes(APPROVAL_GATE_CONTRACT)) {
        // Offline local runs never receive an interactive approval; keep the gate closed.
        return 'false';
    }
    if (systemPrompt.startsWith(WRITE_PLAN_PREFIX)) {
        return 'true';
    }
    return undefined;
}

function classifyIntent(
    userPrompt: string,
): 'trivial' | 'exploratory-research' | 'open-ended-planning' | 'explicit-implementation' | 'ambiguous' {
    const normalized = userPrompt.trim().toLowerCase();
    if (/^(hello|hi|hey|thanks|thank you)\b/.test(normalized)) {
        return 'trivial';
    }
    if (/^(explain|how|what|why|where|when|who|find|summarize|describe|show|list)\b/.test(normalized)) {
        return 'exploratory-research';
    }
    if (/^(implement|add|fix|create|build|write|change|update)\b/.test(normalized)) {
        return 'explicit-implementation';
    }
    if (/^(refactor|improve|clean up|optimize)\b/.test(normalized) || /^make\b.*\bbetter\b/.test(normalized)) {
        return 'open-ended-planning';
    }
    return 'ambiguous';
}

function classifyAmbiguity(userPrompt: string): 'clear' | 'unclear' | 'on-the-fence' {
    const normalized = userPrompt.trim().toLowerCase();
    if (normalized.length === 0) {
        return 'unclear';
    }
    if (/\b(something|anything|whatever|idk|not sure)\b/.test(normalized)) {
        return 'unclear';
    }
    // Prefer clear so offline local runs advance into explore/draft rather than
    // looping on ask-one-question without a human reply.
    return 'clear';
}

function classifyExploreDecision(userPrompt: string): 'needs-exploration' | 'direct-draft' {
    const normalized = userPrompt.trim().toLowerCase();
    if (/^(hello|hi|hey|thanks|thank you)\b/.test(normalized)) {
        return 'direct-draft';
    }
    if (normalized.split(/\s+/).length <= 4 && /^(rename|typo|comment)\b/.test(normalized)) {
        return 'direct-draft';
    }
    return 'needs-exploration';
}
