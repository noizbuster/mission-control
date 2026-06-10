import { z } from 'zod';
import { AbgNodeKindSchema, AbgNodeStatusSchema } from './abg-constants.js';
import { AbgEmbeddedEventSchema, AbgSignalTypeSchema } from './abg-signal.js';
import { ApprovalPolicyDecisionSchema } from './approval.js';

export {
    ABG_TOOL_OUTCOME_STATUSES,
    type AbgBlackboardEntry,
    AbgBlackboardEntrySchema,
    type AbgGraphSnapshot,
    AbgGraphSnapshotSchema,
    type AbgNodeSnapshot,
    AbgNodeSnapshotSchema,
    type AbgToolOutcomeSnapshot,
    AbgToolOutcomeSnapshotSchema,
    type AbgToolOutcomeStatus,
    AbgToolOutcomeStatusSchema,
} from './abg-snapshot.js';

const AuthorablePolicyDecisionSchema = z.preprocess(
    (value) => (value === 'requires-approval' ? 'requires_approval' : value),
    ApprovalPolicyDecisionSchema,
);

export const AbgModelFallbackSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    variantID: z.string().min(1).optional(),
});
export type AbgModelFallback = z.infer<typeof AbgModelFallbackSchema>;

export const AbgNodeModelOptionsSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    variantID: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    budgetCents: z.number().int().nonnegative().optional(),
    fallbacks: z.array(AbgModelFallbackSchema).optional(),
});
export type AbgNodeModelOptions = z.infer<typeof AbgNodeModelOptionsSchema>;

export const AbgRulePredicateSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('event.type.equals'),
        eventType: z.string().min(1),
    }),
    z.object({
        kind: z.literal('signal.type.equals'),
        signalType: AbgSignalTypeSchema,
    }),
    z.object({
        kind: z.literal('node.status.equals'),
        nodeId: z.string().min(1),
        status: AbgNodeStatusSchema,
    }),
    z.object({
        kind: z.literal('blackboard.key.exists'),
        key: z.string().min(1),
    }),
    z.object({
        kind: z.literal('blackboard.value.equals'),
        key: z.string().min(1),
        value: z.unknown(),
    }),
    z.object({
        kind: z.literal('policy.decision.equals'),
        decision: AuthorablePolicyDecisionSchema,
    }),
]);
export type AbgRulePredicate = z.infer<typeof AbgRulePredicateSchema>;

export const AbgRuleSpecSchema = z.object({
    id: z.string().min(1),
    description: z.string().min(1).optional(),
    when: AbgRulePredicateSchema,
    activate: z.string().min(1).optional(),
});
export type AbgRuleSpec = z.infer<typeof AbgRuleSpecSchema>;

export const AbgEdgeSpecSchema = z.object({
    id: z.string().min(1).optional(),
    source: z.string().min(1),
    target: z.string().min(1),
    condition: z.string().min(1).optional(),
    mapping: z.record(z.string().min(1), z.string().min(1)).optional(),
    priority: z.number().int().optional(),
});
export type AbgEdgeSpec = z.infer<typeof AbgEdgeSpecSchema>;

export const AbgNodeSpecSchema = z.object({
    id: z.string().min(1),
    kind: AbgNodeKindSchema,
    label: z.string().min(1).optional(),
    implementation: z.string().min(1).optional(),
    model: AbgNodeModelOptionsSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    children: z.array(z.string().min(1)).optional(),
    rules: z.array(z.string().min(1)).optional(),
    config: z.record(z.string().min(1), z.unknown()).optional(),
});
export type AbgNodeSpec = z.infer<typeof AbgNodeSpecSchema>;

export const AbgPolicySpecSchema = z.object({
    id: z.string().min(1),
    capability: z.string().min(1),
    decision: AuthorablePolicyDecisionSchema,
    reason: z.string().min(1).optional(),
});
export type AbgPolicySpec = z.infer<typeof AbgPolicySpecSchema>;
export const AbgPolicyDecisionSchema = ApprovalPolicyDecisionSchema;
export type AbgPolicyDecision = z.infer<typeof AbgPolicyDecisionSchema>;

export const AbgGraphDefaultsSchema = z.object({
    model: AbgNodeModelOptionsSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    retryLimit: z.number().int().nonnegative().optional(),
    maxNodeRuns: z.number().int().positive().optional(),
});
export type AbgGraphDefaults = z.infer<typeof AbgGraphDefaultsSchema>;

export const AbgGraphSpecSchema = z
    .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
        entryNodeId: z.string().min(1),
        defaults: AbgGraphDefaultsSchema.optional(),
        nodes: z.array(AbgNodeSpecSchema).min(1),
        edges: z.array(AbgEdgeSpecSchema).default([]),
        rules: z.array(AbgRuleSpecSchema).default([]),
        policies: z.array(AbgPolicySpecSchema).default([]),
    })
    .superRefine((graph, ctx) => {
        const nodeIds = new Set<string>();
        for (const [index, node] of graph.nodes.entries()) {
            if (nodeIds.has(node.id)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['nodes', index, 'id'],
                    message: 'ABG graph node ids must be unique',
                });
            }
            nodeIds.add(node.id);
        }
        if (!nodeIds.has(graph.entryNodeId)) {
            ctx.addIssue({
                code: 'custom',
                path: ['entryNodeId'],
                message: `unknown ABG graph entry node: ${graph.entryNodeId}`,
            });
        }
        for (const [index, edge] of graph.edges.entries()) {
            if (!nodeIds.has(edge.source)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['edges', index, 'source'],
                    message: `unknown ABG edge source: ${edge.source}`,
                });
            }
            if (!nodeIds.has(edge.target)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['edges', index, 'target'],
                    message: `unknown ABG edge target: ${edge.target}`,
                });
            }
        }
        const ruleIds = new Set<string>();
        for (const [index, rule] of graph.rules.entries()) {
            if (ruleIds.has(rule.id)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['rules', index, 'id'],
                    message: 'ABG graph rule ids must be unique',
                });
            }
            ruleIds.add(rule.id);
            if (rule.activate !== undefined && !nodeIds.has(rule.activate)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['rules', index, 'activate'],
                    message: `unknown ABG rule activation node: ${rule.activate}`,
                });
            }
        }
        for (const [index, edge] of graph.edges.entries()) {
            if (edge.condition !== undefined && !ruleIds.has(edge.condition)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['edges', index, 'condition'],
                    message: `unknown ABG edge condition rule: ${edge.condition}`,
                });
            }
        }
    });
export type AbgGraphSpec = z.infer<typeof AbgGraphSpecSchema>;

export const AbgGraphInputSchema = z.object({
    graphId: z.string().min(1).optional(),
    input: z.record(z.string().min(1), z.unknown()).optional(),
    events: z.array(AbgEmbeddedEventSchema).optional(),
});
export type AbgGraphInput = z.infer<typeof AbgGraphInputSchema>;

export const AbgRuntimeErrorSchema = z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
});
export type AbgRuntimeError = z.infer<typeof AbgRuntimeErrorSchema>;

export const AbgEventMetadataSchema = z.object({
    graphId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    nodeKind: AbgNodeKindSchema.optional(),
    signalType: AbgSignalTypeSchema.optional(),
    causationId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    model: AbgNodeModelOptionsSchema.optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    error: AbgRuntimeErrorSchema.optional(),
});
export type AbgEventMetadata = z.infer<typeof AbgEventMetadataSchema>;

export {
    ABG_GRAPH_STATUSES,
    ABG_NODE_KINDS,
    ABG_NODE_STATUSES,
    type AbgGraphStatus,
    AbgGraphStatusSchema,
    type AbgNodeKind,
    AbgNodeKindSchema,
    type AbgNodeStatus,
    AbgNodeStatusSchema,
} from './abg-constants.js';
export {
    ABG_SIGNAL_TYPES,
    type AbgEmbeddedEvent,
    AbgEmbeddedEventSchema,
    type AbgSignal,
    AbgSignalSchema,
    type AbgSignalType,
    AbgSignalTypeSchema,
} from './abg-signal.js';
