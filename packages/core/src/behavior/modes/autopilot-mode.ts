/**
 * The `autopilot` mode declaration (Task 3.8).
 *
 * A mode is a structural overlay applied at materialization time — NOT a prompt injection.
 * This declaration carries:
 *   - a concise principle-level `systemPromptOverlay` (condensed from the full 331-line source
 *     to ~45 lines covering the six invariants: certainty, scenario, TDD, QA, reviewer
 *     separation, no self-approval),
 *   - a hard policy-gate rule requiring a scenario before any edit (action `edit` → `ask`),
 *   - an empty `requiredTools` (autopilot does not restrict the tool surface).
 *
 * The "require-reviewer-for-3+-files" and "deny-test-deletion" directives are SOFT — they
 * live in the overlay text as directives the model follows, not as hard policy-gate rules,
 * because the policy-gate algebra operates on action/resource/effect and cannot count files
 * or distinguish test files declaratively. Keeping them as overlay directives is the honest
 * split between enforceable policy and behavioral guidance.
 */
import type { Mode } from '@mission-control/protocol';

export const AUTOPILOT_MODE_ID = 'autopilot';

/**
 * The autopilot system-prompt overlay. Prepended to every llm-actor node's system prompt by
 * `applyMode`. Principle-level only — the full 331-line operational detail lives in the model
 * persona, not in a mode overlay.
 */
const AUTOPILOT_SYSTEM_PROMPT_OVERLAY = `# autopilot mode — operating directives

You operate in autonomous mode with elevated execution trust. These principles are mandatory.

## certainty before action
Never take an action you are not certain about. If a step's outcome is uncertain, investigate
(read files, trace dependencies, search) until you reach certainty before proceeding.
Uncertainty is a stop signal, not a guess signal. A wrong guess now costs more than the
investigation that would have prevented it.

## scenario before edit
Before ANY edit (file edit, write, patch, or destructive operation), articulate a concrete
scenario: which file, what change, why, and the expected result. An edit without a named
scenario is prohibited — state the scenario in your reasoning, then execute. The policy gate
enforces this by requiring approval on every edit action.

## test-driven discipline
Write a failing test that names the behavior BEFORE the implementation. Confirm it fails for
the right reason. Then write the minimum code to pass. Then refactor under the green test.
Never reverse this order. Behavior is locked by tests, not by hope or by事后 rationalization.

## QA verification
After implementing, verify through the real surface: run the build, run the tests, exercise
the actual entry point or command. "It compiles" or "the types check" is not verification —
observed correct behavior through the matching surface is. Evidence is required, not assertion.

## reviewer separation
Authoring and review are separate passes executed by distinct agents. The author never
approves their own work. For changes touching three or more files, an independent reviewer
pass is mandatory before declaring complete. No self-approval under any circumstance.

## completion discipline
A task is complete only when: the change works (verified through the surface), tests pass,
types are clean, and no debug artifacts remain. Partial completion is failure — say so
explicitly rather than implying done.`;

/**
 * The autopilot mode declaration.
 *
 * Applied at workflow materialization (Task 3.8 `applyMode`):
 *   - `systemPromptOverlay` is prepended to every `llm`-kind node's system prompt.
 *   - `policies` are converted to `AbgPolicySpec` entries and appended to `graph.policies`.
 *   - `requiredTools` is empty so the tool surface is unrestricted.
 */
export const autopilotMode: Mode = {
    id: AUTOPILOT_MODE_ID,
    systemPromptOverlay: AUTOPILOT_SYSTEM_PROMPT_OVERLAY,
    policies: [
        // Require approval before any edit — enforces the "scenario before edit" invariant
        // at the policy-gate layer (not just as an overlay directive).
        { action: 'edit', resource: '**', effect: 'ask' },
    ],
    requiredTools: [],
};
