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
const PLAN_INTAKE_OUTPUT_KEY = 'intake.complete';
const AMBIGUITY_OUTPUT_KEY = 'ambiguity.classification';
const EXPLORE_DECISION_OUTPUT_KEY = 'explore.decision';
const EXPLORE_COMPLETE_OUTPUT_KEY = 'explore.complete';
const RESEARCH_COMPLETE_OUTPUT_KEY = 'research.complete';
const EXPLORE_COMPLETE_CONTRACT = 'Output ONLY the JSON boolean `true` when complete';
const RESEARCH_UNCLEAR_PREFIX = 'The request outcome is fuzzy';
const ADOPT_DEFAULTS_OUTPUT_KEY = 'defaults.adopted';
const DRAFT_PLAN_OUTPUT_KEY = 'plan.drafted';
const APPROVAL_GATE_OUTPUT_KEY = 'plan.ready';
const APPROVAL_GATE_CONTRACT = 'Output ONLY the JSON boolean `true` when the user explicitly approves';
const WRITE_PLAN_OUTPUT_KEY = 'plan.written';

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

    if (systemPrompt.includes(PLAN_INTAKE_OUTPUT_KEY)) {
        return 'true';
    }
    if (systemPrompt.includes(AMBIGUITY_OUTPUT_KEY)) {
        return classifyAmbiguity(userPrompt);
    }
    if (systemPrompt.includes(EXPLORE_DECISION_OUTPUT_KEY)) {
        return 'needs-exploration';
    }
    if (
        systemPrompt.includes(EXPLORE_COMPLETE_OUTPUT_KEY) ||
        systemPrompt.includes(RESEARCH_COMPLETE_OUTPUT_KEY) ||
        (systemPrompt.includes(EXPLORE_COMPLETE_CONTRACT) &&
            (systemPrompt.includes('Explore the relevant') ||
                systemPrompt.startsWith(RESEARCH_UNCLEAR_PREFIX) ||
                systemPrompt.includes('Deep exploration')))
    ) {
        return 'false';
    }
    if (systemPrompt.includes(ADOPT_DEFAULTS_OUTPUT_KEY)) {
        return 'true';
    }
    // Intentionally no auto-complete for ask-one-question: auto-true re-enters
    // assess-ambiguity and can loop under offline local providers.
    if (systemPrompt.includes(DRAFT_PLAN_OUTPUT_KEY)) {
        return 'true';
    }
    if (systemPrompt.includes(APPROVAL_GATE_OUTPUT_KEY) || systemPrompt.includes(APPROVAL_GATE_CONTRACT)) {
        // Offline local runs never receive an interactive approval; keep the gate closed.
        return 'false';
    }
    if (systemPrompt.includes(WRITE_PLAN_OUTPUT_KEY)) {
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
