/**
 * Pure helpers for planner resume-gate classification and draft frontmatter.
 */
import { isValidPlanSlug } from '../../persistence/plan-format';

export const RESUME_GATE_VALUES = ['fresh', 'resume_approval', 'resume_drafting'] as const;
export type ResumeGateValue = (typeof RESUME_GATE_VALUES)[number];

export const DRAFT_STATUS_VALUES = ['drafting', 'awaiting-approval', 'approved-writing'] as const;
export type DraftStatusValue = (typeof DRAFT_STATUS_VALUES)[number];

/** High-accuracy markers (case-insensitive substring match). */
export const HIGH_ACCURACY_MARKERS: readonly string[] = [
    'high accuracy',
    'ultra high accuracy',
    '고정밀',
    'deep review',
];

// Re-export interview force markers for resume-gate consumers.
export {
    detectInterviewForce,
    INTERVIEW_FORCE_MARKERS,
} from '../planner-interview';

const SLUG_TOKEN_PATTERN = /\bslug:([A-Za-z0-9][A-Za-z0-9_-]{0,79})\b/u;
const MAX_SLUG_LENGTH = 80;
const FALLBACK_SLUG = 'plan';

export type DraftFrontmatter = {
    readonly slug?: string;
    readonly status?: DraftStatusValue;
    readonly intent?: string;
    readonly review_required?: boolean;
    readonly pending_action?: string;
    readonly approach?: string;
};

export type DraftFrontmatterParseResult =
    | { readonly ok: true; readonly frontmatter: DraftFrontmatter; readonly body: string }
    | { readonly ok: false; readonly reason: string };

export type ResumeRehydrateInput = {
    readonly gate: ResumeGateValue;
    readonly markersPresent: boolean;
    readonly frontmatter: DraftFrontmatter;
};

export type ResumeRehydrateOutput = {
    readonly intent?: string;
    readonly review_required?: boolean;
};

/**
 * Derive a stable plan slug from goal text: optional `slug:<name>` token wins,
 * else kebab-case of the goal (max 80). Always returns a valid plan slug.
 */
export function derivePlanSlug(goalText: string): string {
    const tokenMatch = SLUG_TOKEN_PATTERN.exec(goalText);
    if (tokenMatch !== null) {
        const token = tokenMatch[1];
        if (token !== undefined) {
            const fromToken = kebabize(token);
            if (fromToken.length > 0 && isValidPlanSlug(fromToken)) {
                return fromToken;
            }
        }
    }
    const fromGoal = kebabize(goalText);
    if (fromGoal.length > 0 && isValidPlanSlug(fromGoal)) {
        return fromGoal;
    }
    return FALLBACK_SLUG;
}

/** True when user text contains any high-accuracy marker (case-insensitive). */
export function detectHighAccuracyMarkers(text: string): boolean {
    const lower = text.toLowerCase();
    for (const marker of HIGH_ACCURACY_MARKERS) {
        if (lower.includes(marker.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Parse draft markdown frontmatter (YAML subset for known keys). Fail-closed:
 * missing fences or unparseable content → `{ ok: false }`.
 */
export function parseDraftFrontmatter(contents: string): DraftFrontmatterParseResult {
    const trimmed = contents.replace(/^\uFEFF/, '');
    if (!trimmed.startsWith('---')) {
        return { ok: false, reason: 'missing_frontmatter_open' };
    }
    const afterOpen = trimmed.slice(3);
    const closeIndex = afterOpen.search(/\n---\s*(?:\n|$)/u);
    if (closeIndex < 0) {
        return { ok: false, reason: 'missing_frontmatter_close' };
    }
    const yamlBlock = afterOpen.slice(0, closeIndex).replace(/^\n/, '');
    const body = afterOpen.slice(closeIndex).replace(/^\n---\s*\n?/u, '');
    const frontmatter = parseYamlSubset(yamlBlock);
    if (frontmatter === undefined) {
        return { ok: false, reason: 'corrupt_frontmatter' };
    }
    return { ok: true, frontmatter, body };
}

/**
 * Classify resume path from draft status + body presence.
 * - awaiting-approval → resume_approval
 * - drafting with non-empty body → resume_drafting
 * - otherwise → fresh
 */
export function classifyResumeGate(status: string | undefined, bodyNonEmpty: boolean): ResumeGateValue {
    if (status === 'awaiting-approval') {
        return 'resume_approval';
    }
    if (status === 'drafting' && bodyNonEmpty) {
        return 'resume_drafting';
    }
    return 'fresh';
}

/**
 * Rehydrate intent + review_required from frontmatter.
 * On resume paths, frontmatter review_required wins when the user message has
 * no high-accuracy markers. Intent is always restored when present.
 */
export function rehydrateFromFrontmatter(input: ResumeRehydrateInput): ResumeRehydrateOutput {
    const output: { intent?: string; review_required?: boolean } = {};
    const intent = input.frontmatter.intent;
    if (typeof intent === 'string' && intent.length > 0) {
        output.intent = intent;
    }
    const isResume = input.gate === 'resume_approval' || input.gate === 'resume_drafting';
    if (isResume && !input.markersPresent && typeof input.frontmatter.review_required === 'boolean') {
        output.review_required = input.frontmatter.review_required;
    }
    return output;
}

function kebabize(text: string): string {
    const raw = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .replace(/-{2,}/gu, '-');
    return raw.slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, '');
}

function parseYamlSubset(yamlBlock: string): DraftFrontmatter | undefined {
    const result: {
        slug?: string;
        status?: DraftStatusValue;
        intent?: string;
        review_required?: boolean;
        pending_action?: string;
        approach?: string;
    } = {};
    for (const line of yamlBlock.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }
        const colon = trimmed.indexOf(':');
        if (colon <= 0) {
            return undefined;
        }
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        switch (key) {
            case 'slug': {
                const value = unquoteYamlScalar(rawValue);
                if (value.length > 0) result.slug = value;
                break;
            }
            case 'status': {
                const value = unquoteYamlScalar(rawValue);
                if (isDraftStatus(value)) {
                    result.status = value;
                } else if (value.length > 0) {
                    return undefined;
                }
                break;
            }
            case 'intent': {
                result.intent = unquoteYamlScalar(rawValue);
                break;
            }
            case 'review_required': {
                const parsed = parseYamlBoolean(rawValue);
                if (parsed === undefined) return undefined;
                result.review_required = parsed;
                break;
            }
            case 'pending_action': {
                result.pending_action = unquoteYamlScalar(rawValue);
                break;
            }
            case 'approach': {
                result.approach = unquoteYamlScalar(rawValue);
                break;
            }
            default:
                break;
        }
    }
    return result;
}

function isDraftStatus(value: string): value is DraftStatusValue {
    return (DRAFT_STATUS_VALUES as readonly string[]).includes(value);
}

function unquoteYamlScalar(raw: string): string {
    if (raw === '""' || raw === "''") return '';
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        return raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
        return raw.slice(1, -1);
    }
    return raw;
}

function parseYamlBoolean(raw: string): boolean | undefined {
    const value = unquoteYamlScalar(raw).toLowerCase();
    if (value === 'true' || value === 'yes') return true;
    if (value === 'false' || value === 'no') return false;
    return undefined;
}
