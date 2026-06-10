import {
    type AbgNodeStatus,
    type AbgPolicyDecision,
    type AbgRulePredicate,
    AbgRuleSpecSchema,
    type AbgSignalType,
} from '@mission-control/protocol';

export class AbgGraphValidationError extends Error {
    constructor(
        message: string,
        readonly issueCount: number,
    ) {
        super(message);
        this.name = 'AbgGraphValidationError';
    }
}

export type AbgRuleEvaluationInput = {
    readonly eventType?: string;
    readonly signalType?: AbgSignalType;
    readonly nodeStatuses?: Readonly<Record<string, AbgNodeStatus | undefined>>;
    readonly blackboard?: Readonly<Record<string, unknown>>;
    readonly policyDecision?: AbgPolicyDecision;
};

export type CompiledAbgRule = {
    readonly id: string;
    readonly description?: string;
    readonly activate?: string;
    readonly matches: (input: AbgRuleEvaluationInput) => boolean;
};

export function compileAbgRule(input: unknown): CompiledAbgRule {
    const parsed = AbgRuleSpecSchema.safeParse(input);
    if (!parsed.success) {
        throw new AbgGraphValidationError('unsupported ABG rule predicate', parsed.error.issues.length);
    }
    const rule = parsed.data;
    return Object.freeze({
        id: rule.id,
        ...(rule.description !== undefined ? { description: rule.description } : {}),
        ...(rule.activate !== undefined ? { activate: rule.activate } : {}),
        matches: (evaluationInput: AbgRuleEvaluationInput): boolean => predicateMatches(rule.when, evaluationInput),
    });
}

function predicateMatches(predicate: AbgRulePredicate, input: AbgRuleEvaluationInput): boolean {
    switch (predicate.kind) {
        case 'event.type.equals':
            return input.eventType === predicate.eventType;
        case 'signal.type.equals':
            return input.signalType === predicate.signalType;
        case 'node.status.equals':
            return input.nodeStatuses?.[predicate.nodeId] === predicate.status;
        case 'blackboard.key.exists':
            return input.blackboard !== undefined && Object.hasOwn(input.blackboard, predicate.key);
        case 'blackboard.value.equals':
            return input.blackboard !== undefined && Object.is(input.blackboard[predicate.key], predicate.value);
        case 'policy.decision.equals':
            return input.policyDecision === predicate.decision;
        default:
            return assertNever(predicate);
    }
}

function assertNever(value: never): never {
    throw new AbgGraphValidationError(`Unhandled ABG rule predicate: ${String(value)}`, 1);
}
