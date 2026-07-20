/**
 * Deterministic local-provider contracts for workflow system prompts.
 * Covers default/fixer intent path and planner plan-first nodes.
 */

// --- Default + fixer implementer contracts ---
const INTENT_GATE_MARKER = 'You are the intent gate';
const INTENT_GATE_OUTPUT_CONTRACT = 'Output ONLY one class name';
const RESEARCH_GATE_PREFIX = 'Exploratory/research intent.';
const RESEARCH_GATE_OUTPUT_CONTRACT = 'Output ONLY the JSON boolean `true` when complete';
const DELEGATION_GUARD_PREFIX = 'Two checks before delegation:';
const DELEGATION_GUARD_OUTPUT_CONTRACT = 'Output ONLY `true` or `false`';

// --- Planner contracts ---
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
const ROUTING_DEAD_END_CODE = 'routing_dead_end';
const INVALID_STRUCTURED_OUTPUT_CODE = 'invalid_structured_output';

export const LOCAL_PLANNING_RECOVERY_MESSAGE =
    'Planning did not complete. The workflow hit a routing dead-end (often explore.complete stayed false under local/local-echo, which cannot tool-explore). No plan was written under .mc/plans/. Retry with a real tool-calling model via /model, or run #planner explicitly.';

export function localOutputForSystemContract(systemPrompt: string, userPrompt: string): string | undefined {
    if (isEscalationRecoveryContract(systemPrompt)) {
        return LOCAL_PLANNING_RECOVERY_MESSAGE;
    }
    // Intent gate (fixer + default). Use includes so CORRECTION prefixes still match.
    if (systemPrompt.includes(INTENT_GATE_MARKER) && systemPrompt.includes(INTENT_GATE_OUTPUT_CONTRACT)) {
        return classifyIntent(userPrompt);
    }
    if (systemPrompt.includes(RESEARCH_GATE_PREFIX) && systemPrompt.includes(RESEARCH_GATE_OUTPUT_CONTRACT)) {
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
                systemPrompt.includes(RESEARCH_UNCLEAR_PREFIX) ||
                systemPrompt.includes('Deep exploration')))
    ) {
        return 'false';
    }
    if (systemPrompt.includes(ADOPT_DEFAULTS_OUTPUT_KEY)) {
        return 'true';
    }
    if (systemPrompt.includes(DRAFT_PLAN_OUTPUT_KEY)) {
        return 'true';
    }
    if (systemPrompt.includes(APPROVAL_GATE_OUTPUT_KEY) || systemPrompt.includes(APPROVAL_GATE_CONTRACT)) {
        return 'false';
    }
    if (systemPrompt.includes(WRITE_PLAN_OUTPUT_KEY)) {
        return 'true';
    }
    return undefined;
}

function isEscalationRecoveryContract(systemPrompt: string): boolean {
    const trimmed = systemPrompt.trimStart();
    // Sink escalations only (`error=escalated from <node>`). Same-node re-admit
    // corrections also use routing_dead_end but must keep structured gate output.
    if (!trimmed.startsWith('CORRECTION') || !trimmed.includes('escalated from')) {
        return false;
    }
    return trimmed.includes(ROUTING_DEAD_END_CODE) || trimmed.includes(INVALID_STRUCTURED_OUTPUT_CODE);
}

function classifyIntent(
    userPrompt: string,
): 'trivial' | 'exploratory-research' | 'open-ended-planning' | 'explicit-implementation' | 'ambiguous' {
    const normalized = userPrompt.trim().toLowerCase();
    if (/^(hello|hi|hey|thanks|thank you)\b/.test(normalized)) {
        return 'trivial';
    }
    // Pure research openers first so "explain how the build works" is not stolen by \bbuild\b.
    if (/^(explain|how|what|why|where|when|who|find|summarize|describe|show|list)\b/.test(normalized)) {
        return 'exploratory-research';
    }
    // Action openers + bug language → implement (action-default).
    if (
        /^(implement|add|fix|create|build|write|change|update)\b/.test(normalized) ||
        /\b(fix|broken|bug|doesn'?t work|does not work)\b/.test(normalized)
    ) {
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
    return 'clear';
}
