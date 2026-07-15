const INTENT_GATE_PREFIX = 'You are the intent gate for the default workflow.';
const INTENT_GATE_OUTPUT_CONTRACT = 'Output ONLY one class name';
const RESEARCH_GATE_PREFIX = 'Exploratory/research intent.';
const RESEARCH_GATE_OUTPUT_CONTRACT = 'Output ONLY the JSON boolean `true` when complete';
const DELEGATION_GUARD_PREFIX = 'Two checks before delegation:';
const DELEGATION_GUARD_OUTPUT_CONTRACT = 'Output ONLY the JSON boolean `true` or `false`';

export function localOutputForSystemContract(systemPrompt: string, userPrompt: string): string | undefined {
    if (systemPrompt.startsWith(INTENT_GATE_PREFIX) && systemPrompt.includes(INTENT_GATE_OUTPUT_CONTRACT)) {
        return classifyIntent(userPrompt);
    }
    if (systemPrompt.startsWith(RESEARCH_GATE_PREFIX) && systemPrompt.includes(RESEARCH_GATE_OUTPUT_CONTRACT)) {
        return 'true';
    }
    if (systemPrompt.startsWith(DELEGATION_GUARD_PREFIX) && systemPrompt.includes(DELEGATION_GUARD_OUTPUT_CONTRACT)) {
        return 'false';
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
