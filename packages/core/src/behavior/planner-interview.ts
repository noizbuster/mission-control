/**
 * Pure interview-loop routing for the planner CLEAR-path multi-turn interview (plan T4).
 *
 * `routeInterview` is the only authority for the `interview.route` enum
 * (`continue` | `clear` | `cap_adopt`). The interview-loop llm node must
 * respect this contract; unit tests lock the routing table.
 *
 * Cap-first: once turns hit the max, route to cap_adopt regardless of clearance.
 * Clearance wins over continue when under the cap (even under forceInterview).
 * forceInterview never auto-clears without clearance.
 *
 * Interview force markers ("interview me" / "ask me" / "왜 안 물어") set
 * blackboard `interview.force=true` at resume-gate (same pure-field pattern as
 * high-accuracy markers).
 */

/** Hard cap on interview-loop turns before forced adopt-defaults-announce. */
export const PLANNER_MAX_INTERVIEW_TURNS = 6;

/** Equals-routed `interview.route` labels (bi-coverage vocabulary). */
export const INTERVIEW_ROUTE_VALUES = ['continue', 'clear', 'cap_adopt'] as const;
export type InterviewRoute = (typeof INTERVIEW_ROUTE_VALUES)[number];

/**
 * Case-insensitive substrings that force the interview loop to keep asking
 * (never auto-default owner-decisions without explicit clearance).
 */
export const INTERVIEW_FORCE_MARKERS = ['interview me', 'ask me', '왜 안 물어'] as const;

export type RouteInterviewInput = {
    /** Completed interview turns so far (increment once per `continue` entry). */
    readonly turns: number;
    /** True when remaining owner-decisions are resolved enough to draft. */
    readonly clearance: boolean;
    /** Cap; defaults to {@linkcode PLANNER_MAX_INTERVIEW_TURNS}. */
    readonly maxTurns?: number;
    /** True when user text matched an interview-force marker. */
    readonly forceInterview?: boolean;
};

/**
 * True when user text contains any interview-force marker (case-insensitive).
 */
export function detectInterviewForce(text: string): boolean {
    const lower = text.toLowerCase();
    for (const marker of INTERVIEW_FORCE_MARKERS) {
        if (lower.includes(marker.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Authority for `interview.route`:
 * 1. turns >= maxTurns → `cap_adopt` always
 * 2. clearance true → `clear` (even when forceInterview)
 * 3. else → `continue` (forceInterview never auto-clears without clearance)
 */
export function routeInterview(input: RouteInterviewInput): InterviewRoute {
    const maxTurns = input.maxTurns ?? PLANNER_MAX_INTERVIEW_TURNS;
    if (input.turns >= maxTurns) {
        return 'cap_adopt';
    }
    if (input.clearance) {
        return 'clear';
    }
    // forceInterview true keeps continue; false also continues without clearance
    if (input.forceInterview === true) {
        return 'continue';
    }
    return 'continue';
}
