/**
 * LEVER B authoring validation (ABG progress contract).
 *
 * At materialize / authorable load, fail closed when equals-routed structured
 * llm gates lack bi-coverage between `outputEnum` / `outputShape: 'boolean'`
 * and outbound equals edges.
 *
 * Non-structured writers (critic, supervisor, parallel verdict, custom
 * implementations, runtime keys like `llm.loop_active`) are exempt: they do
 * not admit free-form model text through `parseStructuredOutput`.
 */
import type { AbgEdgeSpec, AbgGraphSpec, AbgNodeSpec, AbgRuleSpec } from '@mission-control/protocol';
import { AbgGraphValidationError } from './rule-compiler';

type EqualsEdgeUse = {
    readonly edgeSource: string;
    readonly ruleId: string;
    readonly key: string;
    readonly value: unknown;
};

/**
 * Fail when equals-routed structured llm keys lack enum/boolean shape, when
 * enum labels lack matching outbound equals edges (and no unconditional /
 * select-default escape), or when equals values fall outside the declared enum.
 */
export function assertRoutingKeyBiCoverage(graph: AbgGraphSpec): void {
    const issues: string[] = [];
    const rulesById = new Map(graph.rules.map((rule) => [rule.id, rule] as const));
    const equalsUses = collectEqualsEdgeUses(graph.edges, rulesById);
    const structuredWriters = graph.nodes.filter(isStructuredLlmWriter);

    assertWritersHaveEnumOrBooleanShape(structuredWriters, equalsUses, issues);
    assertEnumLabelsHaveOutboundCoverage(structuredWriters, graph.edges, rulesById, issues);
    assertEqualsValuesInEnum(structuredWriters, equalsUses, issues);

    if (issues.length > 0) {
        throw new AbgGraphValidationError(
            `ABG routing-key bi-coverage failed: ${issues.join('; ')}`,
            issues.length,
        );
    }
}

function collectEqualsEdgeUses(
    edges: readonly AbgEdgeSpec[],
    rulesById: ReadonlyMap<string, AbgRuleSpec>,
): readonly EqualsEdgeUse[] {
    const uses: EqualsEdgeUse[] = [];
    for (const edge of edges) {
        if (edge.condition === undefined) {
            continue;
        }
        const rule = rulesById.get(edge.condition);
        if (rule === undefined || rule.when.kind !== 'blackboard.value.equals') {
            continue;
        }
        uses.push({
            edgeSource: edge.source,
            ruleId: rule.id,
            key: rule.when.key,
            value: rule.when.value,
        });
    }
    return uses;
}

/**
 * Structured llm writer: default llm-actor path that admits `outputKey` via
 * parseStructuredOutput / applyEnumConstraint. Custom `implementation` values
 * (critic, supervisor, test mocks, …) are non-structured writers and exempt.
 */
export function isStructuredLlmWriter(node: AbgNodeSpec): boolean {
    if (node.kind !== 'llm') {
        return false;
    }
    const implementation = node.implementation;
    return implementation === undefined || implementation === 'llm' || implementation === 'llm-actor';
}

function assertWritersHaveEnumOrBooleanShape(
    writers: readonly AbgNodeSpec[],
    equalsUses: readonly EqualsEdgeUse[],
    issues: string[],
): void {
    const equalsKeys = new Set(equalsUses.map((use) => use.key));
    for (const node of writers) {
        const outputKey = readOutputKey(node);
        if (outputKey === undefined || !equalsKeys.has(outputKey)) {
            continue;
        }
        if (hasOutputEnum(node) || isBooleanOutputShape(node)) {
            continue;
        }
        issues.push(
            `node "${node.id}" outputKey "${outputKey}" is equals-routed but lacks outputEnum or outputShape:'boolean'`,
        );
    }
}

function assertEnumLabelsHaveOutboundCoverage(
    writers: readonly AbgNodeSpec[],
    edges: readonly AbgEdgeSpec[],
    rulesById: ReadonlyMap<string, AbgRuleSpec>,
    issues: string[],
): void {
    for (const node of writers) {
        const outputKey = readOutputKey(node);
        const outputEnum = readOutputEnum(node);
        if (outputKey === undefined || outputEnum === undefined) {
            continue;
        }
        const outbound = edges.filter((edge) => edge.source === node.id);
        if (hasUnconditionalOrSelectDefault(node, outbound)) {
            continue;
        }
        const coveredLabels = new Set<string>();
        let equalsRoutesOnOutputKey = false;
        for (const edge of outbound) {
            if (edge.condition === undefined) {
                continue;
            }
            const rule = rulesById.get(edge.condition);
            if (rule === undefined || rule.when.kind !== 'blackboard.value.equals') {
                continue;
            }
            if (rule.when.key !== outputKey) {
                continue;
            }
            equalsRoutesOnOutputKey = true;
            if (typeof rule.when.value === 'string') {
                coveredLabels.add(rule.when.value);
            }
        }
        // Admission-only enums (e.g. key.exists routing on explore.maturity) are not
        // required to fan out one edge per label — only equals-routed gates are.
        if (!equalsRoutesOnOutputKey) {
            continue;
        }
        for (const label of outputEnum) {
            if (!coveredLabels.has(label)) {
                issues.push(
                    `node "${node.id}" outputEnum label "${label}" has no matching equals edge for key "${outputKey}" and no unconditional outbound / select default`,
                );
            }
        }
    }
}

function assertEqualsValuesInEnum(
    writers: readonly AbgNodeSpec[],
    equalsUses: readonly EqualsEdgeUse[],
    issues: string[],
): void {
    const enumByKey = new Map<string, ReadonlySet<string>>();
    for (const node of writers) {
        const outputKey = readOutputKey(node);
        const outputEnum = readOutputEnum(node);
        if (outputKey === undefined || outputEnum === undefined) {
            continue;
        }
        const existing = enumByKey.get(outputKey);
        if (existing === undefined) {
            enumByKey.set(outputKey, new Set(outputEnum));
            continue;
        }
        const merged = new Set(existing);
        for (const label of outputEnum) {
            merged.add(label);
        }
        enumByKey.set(outputKey, merged);
    }

    for (const use of equalsUses) {
        const allowed = enumByKey.get(use.key);
        if (allowed === undefined) {
            continue;
        }
        if (typeof use.value !== 'string' || !allowed.has(use.value)) {
            issues.push(
                `equals value ${JSON.stringify(use.value)} for key "${use.key}" (rule "${use.ruleId}", edge source "${use.edgeSource}") is not in outputEnum ${JSON.stringify([...allowed])}`,
            );
        }
    }
}

function hasUnconditionalOrSelectDefault(
    node: AbgNodeSpec,
    outbound: readonly AbgEdgeSpec[],
): boolean {
    if (outbound.some((edge) => edge.condition === undefined)) {
        return true;
    }
    const selectDefault = node.config?.['selectDefault'];
    if (typeof selectDefault === 'string' && selectDefault.length > 0) {
        return true;
    }
    const defaultTarget = node.config?.['defaultTarget'];
    if (typeof defaultTarget === 'string' && defaultTarget.length > 0) {
        return true;
    }
    return false;
}

function readOutputKey(node: AbgNodeSpec): string | undefined {
    const value = node.config?.['outputKey'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOutputEnum(node: AbgNodeSpec): readonly string[] | undefined {
    const raw = node.config?.['outputEnum'];
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const labels = raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return labels.length > 0 ? labels : undefined;
}

function hasOutputEnum(node: AbgNodeSpec): boolean {
    return readOutputEnum(node) !== undefined;
}

function isBooleanOutputShape(node: AbgNodeSpec): boolean {
    return node.config?.['outputShape'] === 'boolean';
}
